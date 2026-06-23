/**
 * Parses the splat route param of `/f/*` into one of four chat
 * route states:
 *
 *   - "folders":  the root / index view
 *   - "sessions": a folder's session list
 *   - "chat":     a single session inside a folder
 *   - "changes":  the combined worktree diff + snapshot history
 *                 + commit/push actions
 *
 * The `?view=changes` query param turns a sessions or chat URL
 * into a changes request for the same folder. The current session
 * id (if any) is preserved so the tab bar can return the user to
 * the chat they came from.
 *
 * The changes marker is a query param rather than a `/c` path
 * segment so the URL doesn't collide with a folder literally
 * named `c'.
 */
import { pathFromFolderParam } from "./urls";

export type ChatRoute =
  | { k: "folders" }
  | { k: "sessions"; folder: string }
  | { k: "chat"; folder: string; sessionId: string }
  | { k: "changes"; folder: string; sessionId: string | null };

export function parseRoute(
  splat: string | undefined,
  view: string | null,
): ChatRoute {
  if (!splat) return { k: "folders" };
  const wantChanges = view === "changes" || view === "diff" || view === "timeline";
  const parts = splat.split("/");
  const sIdx = parts.indexOf("s");
  if (sIdx === -1) {
    const folder = pathFromFolderParam(splat);
    return wantChanges
      ? { k: "changes", folder, sessionId: null }
      : { k: "sessions", folder };
  }
  // The "s" segment must be the second-to-last: .../s/<id>.
  // Anything else is a malformed URL; treat as root.
  if (sIdx !== parts.length - 2) return { k: "folders" };
  const folder = pathFromFolderParam(parts.slice(0, sIdx).join("/"));
  const sessionId = parts[sIdx + 1];
  return wantChanges
    ? { k: "changes", folder, sessionId }
    : { k: "chat", folder, sessionId };
}
