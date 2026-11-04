import type { Route } from "./+types/api.uploads";
import {
  getUpload,
  readUploadBytes,
  saveUpload,
  MAX_UPLOAD_BYTES,
} from "~/lib/uploads.server";

/**
 * Image upload endpoints (see uploads.server.ts for the store).
 *
 *   POST /api/uploads          multipart, field `file` (one image
 *                              per request; the composer uploads
 *                              as each image is picked so the
 *                              chip can preview + retry early)
 *     → 201 { id, name, mimeType, size }
 *     → 400 not an image / empty · 413 too large
 *
 *   GET /api/uploads/:id       the stored bytes
 *     → 200 image/<mime>, immutable cache (ids are random and
 *        never rewritten — safe to cache forever)
 *     → 404 unknown id
 *
 * Same-origin like /api/notify/*: no token, Origin-guarded. The
 * bytes ride the prompt to the agent (base64 content blocks),
 * so the store holds no secrets beyond what the user already
 * sent; a cross-site POST is still rejected below.
 */

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!originAllowed(request)) {
    return Response.json({ error: "Cross-origin not allowed" }, { status: 403 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Invalid multipart body" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Missing file field" }, { status: 400 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.type === "image/svg+xml") {
    return Response.json(
      {
        error:
          "SVG can't be attached as an image — @-mention the file and the agent reads it as text",
      },
      { status: 400 },
    );
  }
  const meta = await saveUpload(bytes, file.type, file.name);
  if (!meta) {
    return Response.json(
      {
        error:
          bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES
            ? `Image too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`
            : "Not an image",
      },
      { status: bytes.byteLength > MAX_UPLOAD_BYTES ? 413 : 400 },
    );
  }
  return Response.json(meta, { status: 201 });
}

export async function loader({ params }: Route.LoaderArgs) {
  const { id } = params;
  if (!id) {
    return Response.json({ error: "Missing upload id" }, { status: 400 });
  }
  const meta = getUpload(id);
  if (!meta) {
    return Response.json({ error: "Unknown upload" }, { status: 404 });
  }
  const stored = await readUploadBytes(id);
  if (!stored) {
    return Response.json({ error: "Upload bytes missing" }, { status: 404 });
  }
  return new Response(new Uint8Array(stored.bytes), {
    headers: {
      "Content-Type": stored.mimeType,
      // Random ids, content never rewritten under an id.
      "Cache-Control": "private, max-age=31536000, immutable",
      // Defense in depth for the direct-tab case: sandbox without
      // allow-scripts means no script runs even if some future
      // upload path lets an active-content type slip through;
      // nosniff keeps the declared content-type honest. Neither
      // affects <img> embedding (transcript thumbnails).
      "Content-Security-Policy": "sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  });
}