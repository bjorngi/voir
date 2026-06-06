import type { Route } from "./+types/api.folder-diff";
import { diffFiles, type DiffResult } from "~/lib/diff.server";
import { pathFromFolderParam } from "~/lib/urls";
import { sessionManager } from "~/lib/sessions.server";

/**
 * Returns the full git diff for a registered folder.
 *
 *   GET /api/folder-diff?folder=<abs>
 *
 * The diff is computed server-side (the folder is a worktree
 * on disk) and returned as a JSON-serialized `DiffResult`. The
 * client renders it directly — no client-side diff parsing.
 *
 * The endpoint is gated on the folder being currently
 * registered with the SessionManager. We don't want a path
 * the user has no business reading to leak via the diff
 * endpoint; the only folders we'd ever show in the UI are
 * the registered ones, so a 404 on unregistered paths is
 * the right shape.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("folder");
  if (!raw) {
    return Response.json({ error: "Missing ?folder=" }, { status: 400 });
  }
  // url.searchParams.get() already percent-decodes, so the
  // raw value is the literal folder path. pathFromFolderParam
  // re-adds the leading slash that we strip when building the
  // URL in the client.
  const folder = pathFromFolderParam(raw);
  // Only registered folders are allowed. Anything else is
  // either a typo in the URL or a probe for arbitrary paths.
  if (!sessionManager.getFolder(folder)) {
    return Response.json(
      { error: "Unknown folder (not registered)" },
      { status: 404 },
    );
  }
  const result: DiffResult = await diffFiles(folder);
  return Response.json({ folder, ...result });
}
