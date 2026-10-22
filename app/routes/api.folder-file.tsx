import type { Route } from "./+types/api.folder-file";
import { imageMime, readFileContent } from "~/lib/files.server";

/**
 * Read-only file content for the Files tab (see route-parse.ts
 * `?view=files`). Two modes:
 *
 *   GET /api/folder-file?folder=<abs>&file=<rel>
 *     → JSON { content?, size, binary?, tooLarge? }
 *       Traversal-safe: relPath must resolve (symlinks followed)
 *       inside the folder; binaries and >1 MiB files are described,
 *       not delivered.
 *
 *   GET /api/folder-file?...&raw=1
 *     → The raw bytes with a content-type, for raster image
 *       preview. Same bounds and traversal rules.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const folder = url.searchParams.get("folder");
  const file = url.searchParams.get("file");
  const raw = url.searchParams.get("raw") === "1";
  if (!folder || !file) {
    return Response.json(
      { error: "Both ?folder= and ?file= are required" },
      { status: 400 },
    );
  }

  const result = await readFileContent(folder, file);
  if (!result) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (raw) {
    const mime = imageMime(file);
    if (!mime) {
      return Response.json(
        { error: "raw=1 is only supported for raster images" },
        { status: 415 },
      );
    }
    // readFileContent refuses binaries — images ARE binary, so we
    // read the bytes ourselves, but only after the traversal check
    // above has validated the resolved path.
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
      const bytes = await readFile(join(folder, file));
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": mime,
          "Cache-Control": "no-cache",
        },
      });
    } catch {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
  }

  return Response.json({ folder, file, ...result });
}