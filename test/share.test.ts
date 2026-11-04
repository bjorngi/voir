import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createShare,
  getShare,
  flushSharesForTest,
  MAX_SHARE_IMAGES,
} from "../app/lib/share.server";
import { action as shareAction, loader as shareLoader } from "../app/routes/api.share";
import { getUpload } from "../app/lib/uploads.server";

// Isolate both stores (share manifests reference uploads).
process.env.VOIR_DATA_DIR = await mkdtemp(join(tmpdir(), "voir-share-"));

// 1×1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function postShare(fields: { title?: string; text?: string; files?: File[] }): Request {
  const fd = new FormData();
  if (fields.title !== undefined) fd.set("title", fields.title);
  if (fields.text !== undefined) fd.set("text", fields.text);
  for (const f of fields.files ?? []) fd.append("images", f);
  return new Request("http://voir.test/api/share", {
    method: "POST",
    body: fd,
  });
}

async function runAction(req: Request): Promise<Response> {
  return (await shareAction({
    request: req,
  } as Parameters<typeof shareAction>[0])) as Response;
}

async function runLoader(id: string): Promise<Response> {
  return (await shareLoader({
    params: { id },
  } as Parameters<typeof shareLoader>[0])) as Response;
}

test("share: staging stores files through the upload store", async () => {
  const manifest = await createShare({
    title: "Look at this",
    text: "from the gallery",
    files: [
      { bytes: PNG, mimeType: "image/png", name: "cat.png" },
      { bytes: PNG, mimeType: "text/plain", name: "evil.txt" },
    ],
  });
  assert.ok(manifest, "share staged");
  assert.equal(manifest.title, "Look at this");
  assert.equal(manifest.images.length, 1, "non-image fields skipped");
  assert.equal(manifest.images[0].name, "cat.png");
  // The referenced image is a real upload the composer can send.
  assert.ok(getUpload(manifest.images[0].id), "image went through the store");

  assert.equal(getShare(manifest.id)?.text, "from the gallery", "manifest retrievable");
  assert.equal(getShare("ffffffffffff"), undefined, "unknown id");

  assert.equal(
    await createShare({ files: [{ bytes: PNG, mimeType: "text/plain", name: "x" }] }),
    null,
    "nothing shareable → null",
  );
  await flushSharesForTest();
});

test("share: POST /api/share multipart → manifest; GET serves it", async () => {
  const res = await runAction(
    postShare({
      title: "Stack trace",
      files: [new File([PNG], "error.png", { type: "image/png" })],
    }),
  );
  assert.equal(res.status, 201);
  const manifest = await res.json();
  assert.match(manifest.id, /^[0-9a-f]{12}$/);
  assert.equal(manifest.images.length, 1);

  const get = await runLoader(manifest.id);
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), manifest, "GET returns the same manifest");

  const empty = await runAction(
    postShare({ files: [new File([PNG], "x.txt", { type: "text/plain" })] }),
  );
  assert.equal(empty.status, 400, "no text, no valid image → 400");

  const unknown = await runLoader("ffffffffffff");
  assert.equal(unknown.status, 404);
});

test("share: image count is capped, remaining fields still stage", async () => {
  const files = Array.from(
    { length: MAX_SHARE_IMAGES + 2 },
    () => new File([PNG], "p.png", { type: "image/png" }),
  );
  const res = await runAction(postShare({ text: "gallery dump", files }));
  assert.equal(res.status, 201);
  const manifest = await res.json();
  assert.equal(manifest.images.length, MAX_SHARE_IMAGES, "capped at the limit");
  assert.equal(manifest.text, "gallery dump");
});