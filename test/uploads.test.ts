import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveUpload,
  getUpload,
  readUploadBytes,
  resolveUploads,
  flushUploadsForTest,
  MAX_UPLOAD_BYTES,
} from "../app/lib/uploads.server";
import { action as uploadAction, loader as uploadLoader } from "../app/routes/api.uploads";

// The store persists under VOIR_DATA_DIR: isolate the writes
// from the repo's dev-data (must be set before first store
// access; the singleton reads the env lazily per call).
process.env.VOIR_DATA_DIR = await mkdtemp(join(tmpdir(), "voir-uploads-"));

// 1×1 transparent PNG — a real image a browser could send.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function postUpload(file: File): Request {
  const fd = new FormData();
  fd.set("file", file);
  return new Request("http://voir.test/api/uploads", {
    method: "POST",
    body: fd,
  });
}

async function runAction(req: Request): Promise<Response> {
  return (await uploadAction({
    request: req,
  } as Parameters<typeof uploadAction>[0])) as Response;
}

async function runLoader(id: string): Promise<Response> {
  return (await uploadLoader({
    params: { id },
  } as Parameters<typeof uploadLoader>[0])) as Response;
}

test("uploads: store round-trip and validation", async () => {
  const meta = await saveUpload(PNG, "image/png", "dot.png");
  assert.ok(meta, "valid image saved");
  assert.match(meta.id, /^[0-9a-f]{12}$/);
  assert.equal(meta.mimeType, "image/png");
  assert.equal(meta.size, PNG.byteLength);

  assert.equal(getUpload(meta.id)?.name, "dot.png", "index lookup by id");
  const stored = await readUploadBytes(meta.id);
  assert.ok(stored, "bytes readable");
  assert.equal(stored.bytes.compare(PNG), 0, "bytes round-trip");
  assert.equal(stored.mimeType, "image/png");

  assert.equal(await saveUpload(PNG, "text/plain", "no.png"), null, "non-image mime rejected");
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_UPLOAD_BYTES + 1)]);
  assert.equal(await saveUpload(big, "image/png", "big.png"), null, "oversize rejected");

  assert.deepEqual(resolveUploads([meta.id, "ffffffffffff"]), [
    { id: meta.id, name: "dot.png", mimeType: "image/png" },
  ], "resolveUploads keeps known, drops unknown");

  await flushUploadsForTest();
});

test("uploads: POST /api/uploads serves the store", async () => {
  const ok = await runAction(
    postUpload(new File([PNG], "shot.png", { type: "image/png" })),
  );
  assert.equal(ok.status, 201);
  const meta = await ok.json();
  assert.match(meta.id, /^[0-9a-f]{12}$/);
  assert.equal(meta.mimeType, "image/png");

  const badMime = await runAction(
    postUpload(new File([PNG], "note.txt", { type: "text/plain" })),
  );
  assert.equal(badMime.status, 400);

  const missing = await runAction(
    new Request("http://voir.test/api/uploads", {
      method: "POST",
      body: new FormData(),
    }),
  );
  assert.equal(missing.status, 400, "no file field");

  const getOk = await runLoader(meta.id);
  assert.equal(getOk.status, 200);
  assert.equal(getOk.headers.get("Content-Type"), "image/png");
  assert.equal(
    Buffer.from(await getOk.arrayBuffer()).compare(PNG),
    0,
    "GET serves the exact bytes",
  );
  assert.ok(
    getOk.headers.get("Cache-Control")?.includes("immutable"),
    "immutable cache",
  );

  const unknown = await runLoader("ffffffffffff");
  assert.equal(unknown.status, 404);

  const method = await runAction(
    new Request("http://voir.test/api/uploads", { method: "PUT" }),
  );
  assert.equal(method.status, 405);
});

test("uploads: oversize POST is 413, not 400", async () => {
  const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
  const res = await runAction(
    postUpload(new File([big], "big.png", { type: "image/png" })),
  );
  assert.equal(res.status, 413);
});

test("uploads: SVG is rejected (same-origin stored XSS) and GETs are hardened", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const res = await runAction(
    postUpload(new File([svg], "evil.svg", { type: "image/svg+xml" })),
  );
  assert.equal(res.status, 400, "SVG upload rejected");
  assert.match(
    (await res.json()).error,
    /@-mention/,
    "the error points at the text path",
  );
  assert.equal(await saveUpload(Buffer.from(svg), "image/svg+xml", "e.svg"), null, "store refuses SVG too");

  // A benign upload served with hardening headers so a future
  // active-content slip-through can't script a direct tab.
  const ok = await runAction(
    postUpload(new File([PNG], "dot.png", { type: "image/png" })),
  );
  const meta = await ok.json();
  const served = await runLoader(meta.id);
  assert.equal(served.headers.get("Content-Security-Policy"), "sandbox");
  assert.equal(served.headers.get("X-Content-Type-Options"), "nosniff");
});