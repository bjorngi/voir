import type { Route } from "./+types/api.folders";
import { sessionManager } from "~/lib/sessions.server";
import { switchAgentPreset } from "~/lib/supervisor-proxy.server";
import { folderUrl } from "~/lib/urls";

/**
 * External sandbox-manager API.
 *
 *   GET    /api/folders               → list registered folders
 *   POST   /api/folders               → register a new folder
 *   PATCH  /api/folders               → switch an agent's supervisor preset
 *                                     ({ path, sessionId?, name?, preset })
 *                                     or drop Voir's cached view of the
 *                                     agent ({ …, cache: "clear" } — local
 *                                     maintenance, no supervisor involved)
 *   DELETE /api/folders?path=<abs>    → unregister a folder
 *
 * The script that owns the agent process is the one calling these. The
 * script is responsible for:
 *   1. Starting `pi-acp` (or any other ACP-compatible agent) in a folder.
 *   2. Exposing it as an HTTP endpoint that speaks ACP JSON-RPC 2.0:
 *        POST <url>  body=JSON-RPC, response=JSON-RPC (or 204 for notifies)
 *        GET  <url>  text/event-stream, server-pushed notifications
 *   3. Telling Voir to wire up that folder via POST /api/folders.
 *   4. Calling DELETE /api/folders when it tears the agent down.
 */

export async function loader() {
  return {
    folders: sessionManager.listFolders().map((f) => ({
      path: f.path,
      agentUrl: f.agentUrl,
      agentName: f.agentName,
      registeredAt: f.registeredAt,
      status: f.status,
      lastSeenAt: f.lastSeenAt,
      sessionCount: f.sessions.size,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method === "POST") {
    return register(request);
  }
  if (request.method === "PATCH") {
    return agentMaintenance(request);
  }
  if (request.method === "DELETE") {
    return unregister(request);
  }
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

async function register(request: Request) {
  let body: {
    path?: string;
    agentUrl?: string;
    agentName?: string;
    preset?: string;
    presetOptions?: string[];
    supervisor?: { port: number; token?: string };
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.path || !body.agentUrl) {
    return Response.json(
      { error: "Both 'path' and 'agentUrl' are required" },
      { status: 400 },
    );
  }
  try {
    new URL(body.agentUrl);
  } catch {
    return Response.json(
      { error: "agentUrl is not a valid URL" },
      { status: 400 },
    );
  }

  try {
    const folder = await sessionManager.registerFolder({
      path: body.path,
      agentUrl: body.agentUrl,
      agentName: body.agentName,
      // Supervisor awareness (absent for one-shot acp-spawn):
      // which preset launched the agent, the catalog's preset
      // names, and the daemon's loopback API coordinates. The
      // bearer token lives in FolderState (server-side only);
      // folderSummary never exposes it to the browser.
      preset: nonEmptyString(body.preset),
      presetOptions: nonEmptyStringList(body.presetOptions),
      supervisor: supervisorFromBody(body.supervisor),
    });
    return Response.json(
      {
        path: folder.path,
        agentUrl: folder.agentUrl,
        agentName: folder.agentName,
        // Useful info for the script: the URL the user opens
        // in the browser.
        browse: folderUrl(folder.path),
      },
      { status: 201 },
    );
  } catch (err) {
    return Response.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }
}

async function unregister(request: Request) {
  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  const name = url.searchParams.get("name") ?? undefined;
  if (!path) {
    return Response.json(
      { error: "Missing ?path=<absolute path>" },
      { status: 400 },
    );
  }
  try {
    await sessionManager.unregisterFolder(path, name);
  } catch (err) {
    // Ambiguous path (several agents) or unknown name: surface
    // the registered agent names so the caller can retry.
    return Response.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }
  return new Response(null, { status: 204 });
}

/**
 * Switch an agent's supervisor preset — the fence command it
 * runs under — or, with `{ cache: "clear" }`, drop Voir's
 * cached view of the agent (local maintenance, no supervisor
 * involved). Resolves the target (sessionId beats name beats
 * the path's unique agent); a preset switch proxies to the
 * supervisor's loopback API and on success the supervisor has
 * already restarted the agent under the new command, which
 * re-registers with Voir and swaps the agent leg under open
 * chats (that registration is what clears the caches).
 */
async function agentMaintenance(request: Request) {
  let body: {
    path?: string;
    sessionId?: string;
    name?: string;
    preset?: string;
    cache?: string;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.path) {
    return Response.json({ error: "'path' is required" }, { status: 400 });
  }
  if (body.cache === "clear") {
    const cleared = sessionManager.clearAgentCaches(body.path, {
      sessionId: nonEmptyString(body.sessionId),
      name: nonEmptyString(body.name),
    });
    if (!cleared) {
      return Response.json(
        { error: "No registered agent matches" },
        { status: 404 },
      );
    }
    return Response.json({ ok: true, ...cleared });
  }
  if (!body.preset) {
    return Response.json(
      { error: "'preset' is required (or cache: 'clear')" },
      { status: 400 },
    );
  }
  const result = await switchAgentPreset({
    path: body.path,
    sessionId: nonEmptyString(body.sessionId),
    name: nonEmptyString(body.name),
    preset: body.preset,
  });
  if (!result.ok) {
    const payload: Record<string, unknown> = { error: result.error };
    if (result.available) payload.available = result.available;
    return Response.json(payload, { status: result.status });
  }
  return Response.json({
    name: result.name,
    preset: result.preset,
    previous: result.previous,
    changed: result.changed,
  });
}

// -- registration-body sanitizers ----------------------------------------
// The API is open; supervisor awareness is stored only if it is
// genuinely well-formed. Malformed fields degrade the agent to
// "not supervisor-managed" (no preset switch), never to a crash.

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function nonEmptyStringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && !!x);
  return out.length > 0 ? out : undefined;
}

function supervisorFromBody(
  v: unknown,
): { port: number; token?: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as { port?: unknown; token?: unknown };
  if (
    typeof s.port !== "number" ||
    !Number.isInteger(s.port) ||
    s.port <= 0 ||
    s.port > 65535
  ) {
    return undefined;
  }
  return {
    port: s.port,
    ...(typeof s.token === "string" && s.token ? { token: s.token } : {}),
  };
}
