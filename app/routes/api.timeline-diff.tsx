import type { Route } from "./+types/api.timeline-diff";
import { diffSnapshots } from "~/lib/timeline.server";

/**
 * GET /api/timeline-diff?folder=<path>&from=<id>[&to=<id>]
 *
 * Diff between two snapshots. If `to` is omitted, the diff is
 * between `from` and the current worktree state.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const folder = url.searchParams.get("folder");
  const fromId = url.searchParams.get("from");
  const toId = url.searchParams.get("to") ?? undefined;
  if (!folder || !fromId) {
    return Response.json(
      { error: "Missing folder or from" },
      { status: 400 },
    );
  }
  const result = await diffSnapshots(folder, fromId, toId);
  return Response.json(result);
}
