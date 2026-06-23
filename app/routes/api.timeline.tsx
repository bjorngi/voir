import type { Route } from "./+types/api.timeline";
import { list } from "~/lib/timeline.server";

/**
 * GET /api/timeline?folder=<path>
 *
 * Returns the list of snapshots for a folder, newest first.
 * Each entry carries the turn number, prompt, timestamp, and
 * a diff-vs-HEAD summary so the timeline can render its cards
 * without a second round-trip.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const folder = url.searchParams.get("folder");
  if (!folder) {
    return Response.json({ error: "Missing folder" }, { status: 400 });
  }
  const snapshots = await list(folder);
  return Response.json({ snapshots });
}
