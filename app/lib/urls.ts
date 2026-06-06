/**
 * URL helpers for session folders.
 *
 * Folder paths are absolute filesystem paths (e.g. `/home/me/worktrees/feat-42`).
 * We want them to look readable in the URL bar:
 *
 *   /f/home/me/worktrees/feat-42
 *   /f/home/me/worktrees/feat-42/s/019e8cae-…
 *
 * `encodeURI` is used (not `encodeURIComponent`) so that `/` survives
 * encoding. The `…%20` case for spaces still works.
 *
 * On the server side, React Router gives us the raw path-segment value
 * (with `%20`-style escapes decoded), so a single split on `/` recovers
 * the original path. We DO NOT touch the leading `/` — the route is `/f/:folder`
 * (single segment), so the first character of the param is the path's first char.
 */

export function folderUrl(path: string): string {
  return `/f/${encodeURI(path).replace(/^\//, "")}`;
}

export function sessionUrl(path: string, sessionId: string): string {
  return `${folderUrl(path)}/s/${sessionId}`;
}

export function streamUrl(path: string, sessionId: string): string {
  // The SSE endpoint is keyed by sessionId; folder is passed as a query param
  // for the server-side lookup.
  return `/api/sessions/${sessionId}/stream?folder=${encodeURIComponent(path)}`;
}

/**
 * Reconstruct an absolute folder path from the `:folder` route param.
 *
 * Route param: `home/me/worktrees/feat-42`
 * Returns:     `/home/me/worktrees/feat-42`
 */
export function pathFromFolderParam(folderParam: string): string {
  // The param is already URL-decoded by the router. Re-add the leading slash.
  return "/" + folderParam.replace(/^\/+/, "");
}
