import type { Route } from "./+types/api.share";
import { createShare, getShare, MAX_SHARE_IMAGES } from "~/lib/share.server";
import { MAX_UPLOAD_BYTES } from "~/lib/uploads.server";

/**
 * Share-target staging (see share.server.ts for the flow).
 *
 *   POST /api/share            multipart: `title`?, `text`?,
 *                              one or more `images` file fields
 *                              (the manifest share_target names
 *                              the file field "images")
 *     → 201 { id, title, text, images: ImageRef[] }
 *     → 400 nothing shareable in the payload
 *
 *   GET /api/share/:id         the staged manifest (the
 *                              ShareSheet's preview fetch; the
 *                              chat loader resolves it
 *                              server-side instead)
 *
 * The POST caller is the service worker (public/sw.js), which
 * intercepts the OS share POST at /share — no Origin header on
 * a SW-initiated fetch, so there's no origin guard here; the
 * endpoint stores files, nothing more, and the upload store's
 * mime/size caps apply to every field.
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Invalid multipart body" }, { status: 400 });
  }
  const title = form.get("title");
  const text = form.get("text");
  const files = form
    .getAll("images")
    .filter((f): f is File => f instanceof File && f.size > 0);
  // Cap the raw read before staging: a hostile client could
  // POST gigabytes of file fields; the store would reject the
  // bytes one by one but only after buffering them.
  if (files.some((f) => f.size > MAX_UPLOAD_BYTES)) {
    return Response.json(
      { error: `Image too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)` },
      { status: 413 },
    );
  }
  const staged = await createShare({
    title: typeof title === "string" ? title : undefined,
    text: typeof text === "string" ? text : undefined,
    files: await Promise.all(
      files.map(async (f) => ({
        bytes: new Uint8Array(await f.arrayBuffer()),
        mimeType: f.type || "application/octet-stream",
        name: f.name || "shared-image",
      })),
    ),
  });
  if (!staged) {
    return Response.json(
      { error: "Nothing shareable (no text, no valid images)" },
      { status: 400 },
    );
  }
  if (files.length > MAX_SHARE_IMAGES) {
    console.warn(
      `[share] dropped ${files.length - MAX_SHARE_IMAGES} image(s) past the cap`,
    );
  }
  return Response.json(staged, { status: 201 });
}

export async function loader({ params }: Route.LoaderArgs) {
  const { id } = params;
  if (!id) {
    return Response.json({ error: "Missing share id" }, { status: 400 });
  }
  const manifest = getShare(id);
  if (!manifest) {
    return Response.json({ error: "Unknown share" }, { status: 404 });
  }
  return Response.json(manifest);
}