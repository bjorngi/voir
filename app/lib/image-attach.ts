/**
 * Client-side image preparation for upload (browser-only module).
 *
 * Phone photos are 4–12MB; an ACP image content block carries
 * the image as base64 inside the JSON-RPC prompt frame, and the
 * model's vision pipeline downscales anyway — so we shrink
 * before upload: longest edge ≤ 2048px, re-encoded as JPEG at
 * 0.85. Screenshots (already small) pass through untouched.
 *
 * Deliberately browser-only heuristics:
 *  - decode via createImageBitmap (Chrome/Safari 15+/Firefox);
 *    no fallback to <img> — if the browser can't decode it
 *    (e.g. HEIC on Android Chrome), the original file is sent
 *    as-is and the server's mime/size caps are the only gate;
 *  - never upscale; never grow the file (if the re-encode came
 *    out bigger — e.g. a tiny PNG → JPEG — keep the original);
 *  - the result keeps a .jpg name derived from the original so
 *    the upload store's display name stays meaningful.
 */

/** Below this size, the original is good enough as-is. */
const SKIP_SHRINK_BYTES = 512 * 1024;
const MAX_EDGE = 2048;
const JPEG_QUALITY = 0.85;

export async function prepareImage(file: File): Promise<File> {
  if (file.size <= SKIP_SHRINK_BYTES) return file;
  if (typeof createImageBitmap !== "function") return file;
  if (!file.type.startsWith("image/")) return file;
  // SVGs scale losslessly and are usually tiny; re-encoding one
  // to JPEG rasterizes it for no size win.
  if (file.type === "image/svg+xml") return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // undecodable here → let the server/agent decide
  }
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    if (!blob || blob.size >= file.size) return file;
    const base = (file.name || "image").replace(/\.[^.]+$/, "") || "image";
    return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}

/** Upload one image to the store; returns the stored meta. */
export async function uploadImage(
  file: File,
): Promise<{ id: string; name: string; mimeType: string; size: number }> {
  const body = new FormData();
  body.set("file", file);
  const res = await fetch("/api/uploads", { method: "POST", body });
  if (!res.ok) {
    let message = `upload failed (${res.status})`;
    try {
      const data = await res.json();
      if (typeof data.error === "string") message = data.error;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}