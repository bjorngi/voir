import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseComposerPayload,
  imageWireBlocks,
  rewriteImageMarkers,
} from "../app/lib/composer-payload";
import type { ImageRef } from "../app/lib/chat-types";

// rewriteImageMarkers is pure, but its callers pair it with the
// upload store; the store itself is exercised in uploads.test.ts
// — here the resolver is injected by hand.

const UP = (id: string): ImageRef => ({
  id,
  name: `photo-${id.slice(0, 4)}.jpg`,
  mimeType: "image/jpeg",
});

test("parseComposerPayload: text, resources and image ids", () => {
  const raw = JSON.stringify({
    text: "what is this ",
    resources: [{ path: "/x/a.ts", name: "a.ts" }],
    images: [
      { id: "ab12cd34ef56", name: "one.jpg" },
      { id: "ab12cd34ef56", name: "dup" },
      { id: "not-hex!", name: "bad" },
    ],
  });
  const parsed = parseComposerPayload(raw)!;
  assert.deepEqual(
    parsed.blocks,
    [
      { type: "text", text: "what is this" },
      {
        type: "resource_link",
        uri: "file:///x/a.ts",
        name: "a.ts",
        mimeType: undefined,
      },
    ],
    "text + resource_link blocks, image ids held separately",
  );
  assert.deepEqual(parsed.imageIds, ["ab12cd34ef56"], "dedup + hex validation");
});

test("parseComposerPayload: empty, invalid and missing", () => {
  assert.deepEqual(parseComposerPayload(null), { blocks: [], imageIds: [] });
  assert.deepEqual(parseComposerPayload(""), { blocks: [], imageIds: [] });
  assert.equal(parseComposerPayload("{nope"), null);
  assert.equal(parseComposerPayload("42"), null);
  // images-only payload: no text block, ids carried
  const imgOnly = parseComposerPayload(
    JSON.stringify({ images: [{ id: "000000000000" }] }),
  )!;
  assert.equal(imgOnly.blocks.length, 0);
  assert.deepEqual(imgOnly.imageIds, ["000000000000"]);
});

test("imageWireBlocks: image content block followed by its marker", () => {
  const blocks = imageWireBlocks({
    id: "ab12cd34ef56",
    mimeType: "image/png",
    data: "aGk=",
  });
  assert.deepEqual(blocks, [
    { type: "image", mimeType: "image/png", data: "aGk=" },
    { type: "text", text: "[Image: ab12cd34ef56]" },
  ]);
});

test("rewriteImageMarkers: whole-line markers resolve and drop", () => {
  const { text, images } = rewriteImageMarkers(
    "what is this\n[Image: ab12cd34ef56]",
    (id) => (id === "ab12cd34ef56" ? UP(id) : undefined),
  );
  assert.equal(text, "what is this");
  assert.equal(images.length, 1);
  assert.equal(images[0].name, "photo-ab12.jpg");
});

test("rewriteImageMarkers: glued markers (pi-acp concatenates text blocks without separator)", () => {
  const { text, images } = rewriteImageMarkers(
    "what is this[Image: ab12cd34ef56]",
    (id) => (id === "ab12cd34ef56" ? UP(id) : undefined),
  );
  assert.equal(text, "what is this");
  assert.equal(images.length, 1);
});

test("rewriteImageMarkers: unknown ids keep their raw marker", () => {
  const { text, images } = rewriteImageMarkers(
    "look\n[Image: ffffffffffff]",
    () => undefined,
  );
  assert.equal(text, "look\n[Image: ffffffffffff]");
  assert.equal(images.length, 0);
});

test("rewriteImageMarkers: duplicate markers collapse", () => {
  const { text, images } = rewriteImageMarkers(
    "[Image: ab12cd34ef56]\n[Image: ab12cd34ef56]",
    (id) => (id === "ab12cd34ef56" ? UP(id) : undefined),
  );
  assert.equal(text, "");
  assert.equal(images.length, 1);
});

test("rewriteImageMarkers: blank lines the user typed survive", () => {
  const { text } = rewriteImageMarkers(
    "line one\n\nline two\n[Image: ab12cd34ef56]",
    (id) => (id === "ab12cd34ef56" ? UP(id) : undefined),
  );
  assert.equal(text, "line one\n\nline two");
});