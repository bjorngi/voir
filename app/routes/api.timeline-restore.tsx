import type { Route } from "./+types/api.timeline-restore";
import { restore } from "~/lib/timeline.server";

/**
 * POST /api/timeline-restore
 *
 * Body: { folder: string, snapshotId: string }
 *
 * Restores the worktree to the requested snapshot. Always
 * captures a pre-restore backup first and returns its id so
 * the UI can offer an undo action.
 */
export async function action({ request }: Route.ActionArgs) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  const folder = (body as { folder?: unknown }).folder;
  const snapshotId = (body as { snapshotId?: unknown }).snapshotId;
  if (typeof folder !== "string" || typeof snapshotId !== "string") {
    return Response.json(
      { error: "Missing folder or snapshotId" },
      { status: 400 },
    );
  }
  const result = await restore(folder, snapshotId);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 500 });
  }
  return Response.json({ ok: true, backup: result.backup });
}
