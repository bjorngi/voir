import { redirect } from "react-router";
import type { Route } from "./+types/chat";
import {
  sessionManager,
  folderSummary,
} from "~/lib/sessions.server";
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
  // Pre-populate each folder's session list so the folders
  // view and the folder-scoping check below both see up-to-
  // date sessions. The per-folder work is independent, so we
  // fan out in parallel.
  await Promise.all(states.map((s) => sessionManager.listSessions(s.path)));
  // Cheap per-folder diff summaries for the root view's
  // `+N -M` tag. The git invocations don't depend on each
  // other and they're all <100ms for typical worktrees.
  const summaries = await Promise.all(
    states.map(async (s) => ({
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

  if (p.k === "folders") {
    return {
      k: "folders" as const,
      tree: folders.map((folder) => ({ folder, sessions: folder.sessions })),
      folders,
    };
  }

  const folder = folders.find((f) => f.path === p.folder);
  if (!folder) {
    // Unknown folder: fall through to the root tree view so
    // the user sees a useful page (their other folders)
    // instead of a 404.
    return {
      k: "folders" as const,
      tree: folders.map((f) => ({ folder: f, sessions: f.sessions })),
      folders,
    };
  }

  if (p.k === "sessions") {
    return { k: "sessions" as const, folders, folder, sessions: folder.sessions };
  }

  if (p.k === "changes") {
    // Combined changes view: current diff + snapshot history.
    const [result, snapshots] = await Promise.all([
      diffFiles(p.folder),
      listTimeline(p.folder),
    ]);
    return {
      k: "changes" as const,
      folders,
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
      folders,
      folder,
      fromSessionId: p.sessionId,
      files: await listFiles(p.folder),
    };
  }

  // chat
  const state = sessionManager.getFolder(p.folder);
  if (!state) {
    return { k: "sessions" as const, folders, folder, sessions: folder.sessions };
  }
  let session = state.sessions.get(p.sessionId);
  if (!session) {
    // Unknown sessionId: try to load it (handles pre-restart
    // sessions and bookmarked URLs). If the agent doesn't
    // recognize the ID, create a fresh session and redirect.
    try {
      session = await sessionManager.loadSession(p.folder, p.sessionId);
    } catch {
      return redirectToFreshOrSessions(p.folder, folders, folder);
    }
  } else if (session.messages.length === 0) {
    // The session exists in our in-memory map (typically
    // hydrated from the agent's session/list at folder view
    // time) but has no transcript yet. Replay history by
    // reloading.
    try {
      session = await sessionManager.loadSession(p.folder, p.sessionId);
    } catch {
      // Agent lost the session; treat as unknown and redirect.
      return redirectToFreshOrSessions(p.folder, folders, folder);
    }
  }
  return {
    k: "chat" as const,
    folders,
    folder,
    session: {
      id: session.id,
      title: session.title,
      busy: session.busy,
      messages: session.messages,
      queueDepth: session.queueDepth ?? 0,
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
