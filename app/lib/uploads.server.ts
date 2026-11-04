import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ImageRef } from "./chat-types";

/**
 * The image upload store: voir's own durable copy of the images
 * users attach to prompts (composer paperclip, paste/drop, and
 * the PWA share target).
 *
 * Why voir keeps a copy at all: ACP `session/prompt` takes image
 * content blocks inline (base64 in the JSON-RPC frame), but the
 * *replay* direction — `session/load` — only returns the text of
 * user messages (pi-acp's replay normalizes content to text;
 * verified in its dist: `normalizePiMessageText` drops image
 * parts). Without a voir-side store, image thumbnails would
 * vanish from the transcript after every voir restart or agent
 * resync.
 *
 * The re-association rides the wire marker: every image sent to
 * the agent is accompanied by a text block `[Image: <id>]` (see
 * composer-payload.ts). The marker is part of the user message
 * text, so it survives replay — the replay handler parses the
 * markers, looks the ids up here, and re-attaches the `images`
 * array to the transcript message. Agents that never saw the
 * image still echo the marker text on replay, so even a
 * degraded display (marker, no thumbnail) stays honest.
 *
 * Layout — the same "durable state on the filesystem"
 * convention as push.server.ts and session-status.server.ts:
 *
 *   $VOIR_DATA_DIR/uploads/<id>.<ext>   the bytes
 *   $VOIR_DATA_DIR/uploads/index.json   [{id, name, mimeType, size, createdAt}]
 *
 * The index is read once per process, lazily, into memory
 * (replay parsing looks ids up per user message and must not
 * grow an await); writes are write-through, debounced and
 * atomic (tmp + rename).
 *
 * Retention: none. Images live as long as the sessions that
 * reference them — a replay of a year-old conversation must
 * still find its thumbnails. A shared photo is a few hundred KB
 * after the browser's client-side downscale (see
 * image-attach.ts); shares from the OS share sheet skip the
 * downscale and are capped harder instead (MAX_SHARE_BYTES).
 * Disk growth is bounded by usage; prune by atime if it ever
 * matters.
 */

/** Hard cap on one uploaded image. Env-overridable for tests. */
export const MAX_UPLOAD_BYTES =
  Number(process.env.VOIR_IMAGE_MAX_BYTES) || 15 * 1024 * 1024;

/** Hard cap on the staged text fields of one share. */
export const MAX_SHARE_TEXT_BYTES = 128 * 1024;

export interface UploadMeta {
  id: string;
  /** Original filename as picked (display only). */
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
}

// ── index (in-memory, write-through) ───────────────────────────────

interface IndexEntry extends UploadMeta {}

const globalThis_ = globalThis as typeof globalThis & {
  __voir_uploads?: {
    loaded: boolean;
    byId: Map<string, IndexEntry>;
    dirty: boolean;
    flushTimer: ReturnType<typeof setTimeout> | null;
  };
};

// Survive Vite dev HMR: a fresh module instance must not fork
// the in-memory index (the same trick as sessions.server.ts's
// __radharc_sessions).
const store =
  globalThis_.__voir_uploads ??
  (globalThis_.__voir_uploads = {
    loaded: false,
    byId: new Map<string, IndexEntry>(),
    dirty: false,
    flushTimer: null as ReturnType<typeof setTimeout> | null,
  });

const FLUSH_DEBOUNCE_MS = 500;

function dataDir(): string {
  return process.env.VOIR_DATA_DIR ?? "dev-data";
}

function indexFile(): string {
  return join(dataDir(), "uploads", "index.json");
}

function uploadsDir(): string {
  return join(dataDir(), "uploads");
}

/** Extension for a stored image. Unknown mimes get `.bin`. */
function extFor(mimeType: string): string {
  const known: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  return known[mimeType] ?? "bin";
}

function loadIndex(): void {
  if (store.loaded) return;
  store.loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(indexFile(), "utf8"));
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        if (
          e &&
          typeof e.id === "string" &&
          typeof e.name === "string" &&
          typeof e.mimeType === "string" &&
          typeof e.size === "number" &&
          typeof e.createdAt === "number"
        ) {
          store.byId.set(e.id, e);
        }
      }
    }
  } catch {
    // No index yet (fresh install) or unreadable: start empty.
  }
}

function scheduleFlush(): void {
  if (store.flushTimer !== null) return;
  store.flushTimer = setTimeout(() => {
    store.flushTimer = null;
    void flushIndex();
  }, FLUSH_DEBOUNCE_MS);
}

async function flushIndex(): Promise<void> {
  if (!store.dirty) return;
  store.dirty = false;
  const entries = Array.from(store.byId.values());
  const file = indexFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(entries, null, 2) + "\n");
  await rename(tmp, file);
}

function newId(): string {
  // 12 hex chars: enough to be collision-free at household scale,
  // short enough to keep the wire marker tidy ([Image: ab12…]).
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── API ─────────────────────────────────────────────────────────────

/**
 * Validate and persist one image. Returns the stored meta, or
 * null when rejected (wrong type or too large — the route
 * translates to a 4xx; the store has no opinions about HTTP).
 *
 * SVG is rejected on purpose: it's an XML document with script
 * rights when opened in a tab, and `/api/uploads/:id` is
 * same-origin — serving it would be stored XSS. Agents that
 * need an SVG read it as text (@-mention), not as an image.
 */
export async function saveUpload(
  bytes: Uint8Array,
  mimeType: string,
  name: string,
): Promise<UploadMeta | null> {
  if (!mimeType.startsWith("image/") || mimeType === "image/svg+xml") {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) {
    return null;
  }
  const id = newId();
  const meta: UploadMeta = {
    id,
    name: name || "image",
    mimeType,
    size: bytes.byteLength,
    createdAt: Date.now(),
  };
  await mkdir(uploadsDir(), { recursive: true });
  const file = join(uploadsDir(), `${id}.${extFor(mimeType)}`);
  const tmp = file + ".tmp";
  await writeFile(tmp, bytes);
  await rename(tmp, file);
  loadIndex();
  store.byId.set(id, meta);
  store.dirty = true;
  scheduleFlush();
  return meta;
}

/** Meta lookup — synchronous, cached, safe for replay-time calls. */
export function getUpload(id: string): UploadMeta | undefined {
  loadIndex();
  return store.byId.get(id);
}

/** The bytes of one stored image, or null when unknown. */
export async function readUploadBytes(id: string): Promise<{
  bytes: Buffer;
  mimeType: string;
} | null> {
  const meta = getUpload(id);
  if (!meta) return null;
  const file = join(uploadsDir(), `${id}.${extFor(meta.mimeType)}`);
  try {
    return { bytes: await readFile(file), mimeType: meta.mimeType };
  } catch {
    return null;
  }
}

/**
 * Resolve a list of upload ids to display refs, dropping
 * unknowns. The `ImageRef` that ends up on ChatMessages and
 * share manifests: name/mimeType for display, id for fetches.
 */
export function resolveUploads(ids: string[]): ImageRef[] {
  loadIndex();
  const out: ImageRef[] = [];
  for (const id of ids) {
    const meta = store.byId.get(id);
    if (meta) out.push({ id, name: meta.name, mimeType: meta.mimeType });
  }
  return out;
}

/** Test seam: flush pending index writes immediately. */
export async function flushUploadsForTest(): Promise<void> {
  if (store.flushTimer !== null) {
    clearTimeout(store.flushTimer);
    store.flushTimer = null;
  }
  await flushIndex();
}