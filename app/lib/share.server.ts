import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { saveUpload, MAX_UPLOAD_BYTES, MAX_SHARE_TEXT_BYTES, type UploadMeta } from "./uploads.server";
import type { ImageRef } from "./chat-types";

/**
 * The share-target staging store (PWA Web Share Target —
 * manifest `share_target`, handler in public/sw.js).
 *
 * When the user shares an image or text from any Android app,
 * the OS POSTs it to the manifest's `action` URL — intercepted
 * by the service worker, which forwards the payload here. The
 * server stages it (files go through the normal upload store;
 * the manifest references them by upload id) and answers with a
 * short id. The SW then redirects the browser to
 * `/?shared=<id>`, where the ShareSheet overlay offers the pick
 * of target chats; picking navigates to the chat URL with
 * `?shared=<id>` and the Composer seeds text + image chips from
 * the manifest (the same consume-once pattern as `?attach=`).
 *
 * Why server-side staging rather than stashing the payload in
 * the SW's Cache API: the bytes must live in the upload store by
 * send time anyway (the prompt carries base64 content blocks
 * resolved by id — no re-upload from the landing page), and the
 * manifest is what the chat loader resolves server-side, so
 * there's no client round-trip flash. A staged share that's
 * never picked costs one manifest row plus its images; nothing
 * cleans them (same retention stance as uploads — see
 * uploads.server.ts).
 *
 * Layout: `$VOIR_DATA_DIR/shares.json` —
 * `{ version: 1, shares: { <id>: { title, text, images, createdAt } } }`,
 * read lazily once per process, write-through + debounced,
 * mirroring session-status.server.ts.
 */

/** Android's share sheet offers arbitrarily many files; cap hard. */
export const MAX_SHARE_IMAGES = 8;

export interface ShareManifest {
  id: string;
  /** The shared item's title, when the source app provided one. */
  title?: string;
  /** The shared text (Android concatenates title+text sometimes). */
  text?: string;
  images: ImageRef[];
  createdAt: number;
}

interface StoreFile {
  version: 1;
  shares: Record<string, Omit<ShareManifest, "id">>;
}

const globalThis_ = globalThis as typeof globalThis & {
  __voir_shares?: {
    loaded: boolean;
    shares: Map<string, ShareManifest>;
    dirty: boolean;
    flushTimer: ReturnType<typeof setTimeout> | null;
  };
};

const store =
  globalThis_.__voir_shares ??
  (globalThis_.__voir_shares = {
    loaded: false,
    shares: new Map<string, ShareManifest>(),
    dirty: false,
    flushTimer: null as ReturnType<typeof setTimeout> | null,
  });

const FLUSH_DEBOUNCE_MS = 500;

function storeFile(): string {
  return join(process.env.VOIR_DATA_DIR ?? "dev-data", "shares.json");
}

function sanitize(parsed: unknown): Map<string, ShareManifest> | null {
  if (!parsed || typeof parsed !== "object") return null;
  const { version, shares } = parsed as {
    version?: unknown;
    shares?: unknown;
  };
  if (version !== 1 || !shares || typeof shares !== "object") return null;
  const clean = new Map<string, ShareManifest>();
  for (const [id, raw] of Object.entries(shares as Record<string, unknown>)) {
    const e = raw as {
      title?: unknown;
      text?: unknown;
      images?: unknown;
      createdAt?: unknown;
    };
    const images: ImageRef[] = Array.isArray(e.images)
      ? (e.images as ImageRef[]).filter(
          (i) => i && typeof i.id === "string",
        )
      : [];
    clean.set(id, {
      id,
      title: typeof e.title === "string" ? e.title : undefined,
      text: typeof e.text === "string" ? e.text : undefined,
      images,
      createdAt: typeof e.createdAt === "number" ? e.createdAt : 0,
    });
  }
  return clean;
}

function load(): void {
  if (store.loaded) return;
  store.loaded = true;
  try {
    const parsed = sanitize(JSON.parse(readFileSync(storeFile(), "utf8")));
    if (parsed) store.shares = parsed;
  } catch {
    // Fresh install / unreadable: start empty.
  }
}

function scheduleFlush(): void {
  if (store.flushTimer !== null) return;
  store.flushTimer = setTimeout(() => {
    store.flushTimer = null;
    void flush();
  }, FLUSH_DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  if (!store.dirty) return;
  store.dirty = false;
  const file: StoreFile = {
    version: 1,
    shares: Object.fromEntries(
      Array.from(store.shares.values()).map(({ id, ...rest }) => [id, rest]),
    ),
  };
  const path = storeFile();
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(file, null, 2) + "\n");
  await rename(tmp, path);
}

function newId(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Stage one share: store the files (via the upload store — the
 * same ids the composer will send), persist the manifest, return
 * it. Files that fail validation (wrong type, too large, over
 * the count cap) are skipped, not fatal — a shared text with a
 * broken 9th image should still arrive as text + 8 images.
 * Returns null only when there was nothing at all to stage.
 */
export async function createShare(input: {
  title?: string;
  text?: string;
  files: Array<{ bytes: Uint8Array; mimeType: string; name: string }>;
}): Promise<ShareManifest | null> {
  const images: ImageRef[] = [];
  for (const f of input.files.slice(0, MAX_SHARE_IMAGES)) {
    if (f.bytes.byteLength > MAX_UPLOAD_BYTES) continue;
    const meta: UploadMeta | null = await saveUpload(
      f.bytes,
      f.mimeType,
      f.name,
    );
    if (meta) images.push({ id: meta.id, name: meta.name, mimeType: meta.mimeType });
  }
  // Cap the text fields: an article share can be megabytes and
  // the manifest feeds the composer draft (sessionStorage quota
  // would silently drop it — see Composer's saveDraft).
  const cap = (s: string | undefined) =>
    s && s.length > MAX_SHARE_TEXT_BYTES
      ? s.slice(0, MAX_SHARE_TEXT_BYTES)
      : s;
  const title = cap(input.title?.trim()) || undefined;
  const text = cap(input.text?.trim()) || undefined;
  if (!title && !text && images.length === 0) return null;
  const id = newId();
  const manifest: ShareManifest = {
    id,
    title,
    text,
    images,
    createdAt: Date.now(),
  };
  load();
  store.shares.set(id, manifest);
  store.dirty = true;
  scheduleFlush();
  return manifest;
}

export function getShare(id: string): ShareManifest | undefined {
  load();
  return store.shares.get(id);
}

/** Test seam: flush pending writes immediately. */
export async function flushSharesForTest(): Promise<void> {
  if (store.flushTimer !== null) {
    clearTimeout(store.flushTimer);
    store.flushTimer = null;
  }
  await flush();
}