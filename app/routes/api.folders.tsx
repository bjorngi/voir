import type { Route } from "./+types/api.folders";
import { sessionManager } from "~/lib/sessions.server";
import { folderUrl } from "~/lib/urls";

/**
 * External sandbox-manager API.
 *
 *   GET    /api/folders               → list registered folders
 *   POST   /api/folders               → register a new folder
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
  if (!path) {
    return Response.json(
      { error: "Missing ?path=<absolute path>" },
      { status: 400 },
    );
  }
  await sessionManager.unregisterFolder(path);
  return new Response(null, { status: 204 });
}
