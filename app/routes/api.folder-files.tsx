import type { Route } from "./+types/api.folder-files";
import { listFiles } from "~/lib/files.server";

/**
 * Returns the file index for a folder, used by the @-mention picker.
 *
 *   GET /api/folder-files?folder=<abs>
 *
 * Cached server-side for 30s per folder. Capped at 5000 files and
 * skips known noise directories (node_modules, .git, build, ...).
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const folder = url.searchParams.get("folder");
  if (!folder) {
    return Response.json({ error: "Missing ?folder=" }, { status: 400 });
  }
  const files = await listFiles(folder);
  return { folder, files };
}
