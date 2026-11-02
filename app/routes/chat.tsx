import { redirect } from "react-router";
import type { Route } from "./+types/chat";
import {
  sessionManager,
  folderSummary,
  activeSnapshot,
} from "~/lib/sessions.server";
import { sessionStatusStore } from "~/lib/session-status.server";
import { diffFiles, diffSummary, type DiffResult } from "~/lib/diff.server";
import { listFiles } from "~/lib/files.server";
import { list as listTimeline } from "~/lib/timeline.server";
import { sessionUrl } from "~/lib/urls";
import { parseRoute } from "~/lib/route-parse";
import type {
  ContentBlock,
  FolderSummary,
} from "~/lib/chat-types";
import { ChatApp } from "~/components/chat/ChatApp";

/** The loader data shape for the chat route. Exported so
 *  client components can type their props without having to
 *  re-derive the union. The loader may also return a
 *  Response (for redirects) — those are handled by React
 *  Router before the component renders, so we strip them
 *  out of the component-facing type. */
export type ChatLoaderData = Extract<
  Awaited<ReturnType<typeof loader>>,
  { k: string }
>;

/**
 * One route, four states (see parseRoute):
 *
 *   /                            → list of folders
 *   /f/<path>                    → list of sessions in a folder
 *   /f/<path>?view=changes       → combined diff + timeline
 *   /f/<path>/s/<id>             → chat
 *   /f/<path>/s/<id>?view=changes → changes for the chat's folder
 *
 * The `?view=changes` query param is used rather than a `/c` path
 * segment so the changes tab doesn't collide with a folder that's
 * literally named `c'.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const p = parseRoute(params["*"], url.searchParams.get("view"));
  const states = sessionManager.listFolders();
  // Pre-populate every path's session list so the folders
  // view and the folder-scoping check below both see up-to-
  // date sessions. Paths can host several agents (same
  // worktree, different engines); listSessions merges their
  // session lists per path, so dedupe first. The per-agent
  // RPC result is TTL-cached in the session manager (see
  // sessions.server.ts), so repeated navigations don't
  // re-trigger the agent-side full-store scan.
  //
  // One degraded agent must never 500 the page — on a
  // supervisor restart (agents rebooting → bridges refuse or
  // 504 after their 30s RPC timeout) this pass used to throw
  // and render the root "Oops!" page instead of the dashboard.
  // Degrade the path instead: the folder tree shows its
  // offline pill, in-memory sessions still render, and the
  // heartbeat/re-registration resyncs when the agent is back.
  //
  // Two bounds keep the dashboard fast while an agent boots
  // (its bridge accepts connections but the child stays silent
  // for tens of seconds):
  //   - LIST_WAIT_MS — a cold session/list is "hundreds of ms
  //     to seconds" (see sessions.server.ts); past 10s the
  //     agent is not answering THIS navigation, so degrade and
  //     paint. The shared in-flight RPC keeps running and
  //     warms the TTL cache once the agent finishes booting.
  //   - already-degraded folders are skipped outright, else
  //     every navigation would re-pay the wait against a
  //     booting agent until its bridge 504s.
  const LIST_WAIT_MS = 10_000;
  const paths = [...new Set(states.map((s) => s.path))];
  await Promise.all(
    paths.map(async (path) => {
      const agents = states.filter((s) => s.path === path);
      if (agents.length > 0 && agents.every((a) => a.status === "degraded")) {
        return;
      }
      try {
        await Promise.race([
          sessionManager.listSessions(path),
          sleep(LIST_WAIT_MS).then(() => {
            throw new Error(
              `session/list did not answer in ${LIST_WAIT_MS}ms`,
            );
          }),
        ]);
      } catch (err) {
        sessionManager.markDegraded(
          path,
          (err as Error)?.message ?? String(err),
        );
      }
    }),
  );
  // Cheap per-folder diff summaries for the root view's
  // `+N -M` tag. The git invocations don't depend on each
  // other and they're all <100ms for typical worktrees — but
  // only the folder tree (root view) and the chat tab badge
  // (active folder) ever render them, so scope the spawns:
  // all folders on the root view, the one folder on chat/files
  // tabs, none on the sessions/changes views. A chat URL for
  // an unknown folder falls through to the root view below,
  // which renders every tag — cover that by testing the path
  // set, not the parsed route.
  const needAllSummaries =
    p.k === "folders" || !paths.includes(p.folder);
  const needOwnSummary = p.k === "chat" || p.k === "files";
  const summaries = await Promise.all(
    states
      .filter(
        (s) =>
          needAllSummaries || (needOwnSummary && s.path === p.folder),
      )
      .map(async (s) => ({
        path: s.path,
        summary: await diffSummary(s.path),
      })),
  );
  const summaryByPath = new Map(
    summaries.map((r) => [r.path, r.summary ?? undefined]),
  );
  const folders = states.map((s) => ({
    ...folderSummary(s),
    diffSummary: summaryByPath.get(s.path),
  }));

  // A path can host several agents (same worktree, different
  // engines/sandboxes). The sidebar and folder views group by
  // path — one row per worktree, session lists merged, agent
  // names joined for the badge. Resolution of which agent owns
  // a given session happens by session id in findOrLoadSession.
  const byPath = new Map<string, FolderSummary>();
  for (const f of folders) {
    const existing = byPath.get(f.path);
    if (!existing) {
      byPath.set(f.path, { ...f });
      continue;
    }
    existing.sessions = [...existing.sessions, ...f.sessions].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
    const names = [
      ...new Set([existing.agentName, f.agentName].filter(Boolean) as string[]),
    ];
    existing.agentName = names.length > 0 ? names.join(" · ") : undefined;
  }
  const grouped = Array.from(byPath.values());

  // The "Working on" seed for the root view (docs/
  // session-status.md). The client poll takes over after the
  // first paint; the snapshot itself resolves from the stubs
  // the listSessions pass above just hydrated.
  const active = await activeSnapshot();

  if (p.k === "folders") {
    return {
      k: "folders" as const,
      tree: grouped.map((folder) => ({ folder, sessions: folder.sessions })),
      folders: grouped,
      active,
    };
  }

  const folder = grouped.find((f) => f.path === p.folder);
  if (!folder) {
    // Unknown folder: fall through to the root tree view so
    // the user sees a useful page (their other folders)
    // instead of a 404.
    return {
      k: "folders" as const,
      tree: grouped.map((f) => ({ folder: f, sessions: f.sessions })),
      folders: grouped,
      active,
    };
  }

  if (p.k === "sessions") {
    return { k: "sessions" as const, folders: grouped, folder, sessions: folder.sessions };
  }

  if (p.k === "changes") {
    // Combined changes view: current diff + snapshot history.
    const [result, snapshots] = await Promise.all([
      diffFiles(p.folder),
      listTimeline(p.folder),
    ]);
    return {
      k: "changes" as const,
      folders: grouped,
      folder,
      fromSessionId: p.sessionId,
      diff: result,
      snapshots,
    };
  }

  if (p.k === "files") {
    // Read-only file explorer: the flat, cached file index (the
    // same one the @-mention picker uses) — the tree is built and
    // file contents are fetched client-side.
    return {
      k: "files" as const,
      folders: grouped,
      folder,
      fromSessionId: p.sessionId,
      files: await listFiles(p.folder),
    };
  }

  // chat
  // Resolve the (path, sessionId) pair to its agent. Handles the
  // in-memory case, replays empty stubs, and probes each agent
  // under the path for sessions voir doesn't know yet. A failing
  // agent leg (bridge down/booting, e.g. during a supervisor
  // restart) degrades the folder and falls through to the same
  // recovery as an unknown session — never the root "Oops!" page.
  let found: Awaited<ReturnType<typeof sessionManager.findOrLoadSession>> =
    undefined;
  try {
    found = await sessionManager.findOrLoadSession(p.folder, p.sessionId);
  } catch (err) {
    sessionManager.markDegraded(
      p.folder,
      (err as Error)?.message ?? String(err),
    );
  }
  if (!found) {
    return redirectToFreshOrSessions(p.folder, grouped, folder);
  }
  const { state, session } = found;
  return {
    k: "chat" as const,
    folders: grouped,
    folder,
    session: {
      id: session.id,
      title: session.title,
      busy: session.busy,
      messages: session.messages,
      queueDepth: session.queueDepth ?? 0,
      // Voir-local overlay label for the header star
      // (docs/session-status.md).
      status: sessionStatusStore.getStatus(p.folder, session.id),
    },
    // "Attach to chat" hand-off from the Files tab: a relpath the
    // Composer seeds as an @-mention on mount, then strips from
    // the URL so reloads don't re-attach.
    attach: url.searchParams.get("attach") ?? undefined,
    availableModels: state.availableModels,
    availableModes: state.availableModes,
    currentModelId: state.currentModelId,
    currentModeId: state.currentModeId,
    availableCommands: state.availableCommands,
  };
}

/**
 * Try to create a new session in `folder` and redirect to it.
 * Used when the chat action can't find or load a sessionId.
 * Falls back to the session list (no redirect) if creation
 * also fails — we never want to throw on a benign lookup.
 */
async function redirectToFreshOrSessions(
  folder: string,
  folders: FolderSummary[],
  knownFolder: FolderSummary,
) {
  try {
    const fresh = await sessionManager.createSession(folder);
    return redirect(sessionUrl(folder, fresh.id));
  } catch {
    return {
      k: "sessions" as const,
      folders,
      folder: knownFolder,
      sessions: knownFolder.sessions,
    };
  }
}

export async function action({ params, request }: Route.ActionArgs) {
  const url = new URL(request.url);
  const p = parseRoute(params["*"], url.searchParams.get("view"));
  const form = await request.formData();
  const intent = form.get("intent");
  if (p.k === "sessions") {
    if (intent === "new") {
      const s = await sessionManager.createSession(p.folder);
      return redirect(sessionUrl(p.folder, s.id));
    }
    return { error: "Unknown intent" };
  }
  if (p.k === "chat") {
    if (intent === "cancel") {
      sessionManager.cancel(p.folder, p.sessionId);
      return { ok: true };
    }
    // The composer submits JSON: { text: string, resources: ResourceRef[] }
    // where each ResourceRef is { path, name, mimeType?, size? }.
    // We expand it into ACP content blocks: a leading text block
    // plus a resource_link per mention.
    const blocks = parseComposerPayload(form.get("payload"));
    if (!blocks) return { error: "Invalid payload" };
    if (blocks.length === 0) return { error: "Empty" };
    void sessionManager.sendMessage(p.folder, p.sessionId, blocks);
    return { ok: true };
  }
  return { error: "Not found" };
}

/** Timer helper for the loader's bounded session/list wait. */
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Decode the Composer's JSON payload into ACP content blocks.
 * Returns null on parse failure. An empty payload is not an
 * error — the caller checks for emptiness and reports it.
 */
function parseComposerPayload(
  raw: FormDataEntryValue | null,
): ContentBlock[] | null {
  if (typeof raw !== "string" || !raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const text =
    typeof (parsed as { text?: unknown }).text === "string"
      ? ((parsed as { text: string }).text as string).trim()
      : "";
  const resources: ContentBlock[] = [];
  const rawResources = (parsed as { resources?: unknown }).resources;
  if (Array.isArray(rawResources)) {
    for (const r of rawResources) {
      if (!r || typeof r !== "object") continue;
      const path = (r as { path?: unknown }).path;
      const name = (r as { name?: unknown }).name;
      if (typeof path !== "string" || typeof name !== "string") continue;
      resources.push({
        type: "resource_link",
        // file:// URI per RFC 3986 (three slashes: empty
        // authority + absolute path)
        uri: "file://" + (path.startsWith("/") ? path : "/" + path),
        name,
        mimeType:
          typeof (r as { mimeType?: unknown }).mimeType === "string"
            ? ((r as { mimeType: string }).mimeType as string)
            : undefined,
      });
    }
  }
  return text
    ? [{ type: "text", text }, ...resources]
    : resources;
}

export default function App({ loaderData }: Route.ComponentProps) {
  return <ChatApp data={loaderData} />;
}
