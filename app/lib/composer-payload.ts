import type { ContentBlock, ImageRef } from "./chat-types";

/**
 * Composer payload parsing + the image wire-marker convention.
 *
 * Pure and isomorphic (no Node imports) so the chat action, the
 * session manager and the tests all share one definition.
 *
 * The wire contract for image prompts:
 *
 *   [{ type: "text", text: "<user text>" },
 *    { type: "image", mimeType: "image/jpeg", data: "<base64>" },
 *    { type: "text", text: "[Image: ab12cd34ef56]" },
 *    … one image + marker pair per attachment]
 *
 * The marker is what makes images replay-safe. ACP's replay
 * direction (`session/load`) only returns the *text* of user
 * messages — pi-acp normalizes content to text and drops image
 * parts (see uploads.server.ts). The marker rides the text, so
 * after a voir restart / agent resync the replayed message can
 * be re-associated with the stored upload by id. Agents read it
 * as an honest label ("an image accompanies this message,
 * handle <id>"); hosts that don't know the convention degrade
 * to showing the marker text.
 */

/** Upload id charset — [0-9a-f]{12} from uploads.server.newId. */
const ID = "[0-9a-f]{12}";

/**
 * The marker, matchable anywhere in a line: `[Image: ab12cd34ef56]`.
 * Not line-anchored on purpose — pi-acp concatenates a turn's
 * text blocks with *no* separator when it builds the wire
 * message, so on replay the marker comes back glued to the
 * user's text ("what is this[Image: abc…]"). Live sends (voir's
 * own projection) see it on its own line; both must parse.
 */
export const IMAGE_MARKER_RE = new RegExp(`\\[Image: (${ID})\\]`, "gi");

/** What the Composer submits as `payload` (JSON in the form data). */
export interface ComposerPayload {
  text: string;
  resources: Array<{ path: string; name: string; mimeType?: string }>;
  images: ImageRef[];
}

/**
 * Parse the Composer's JSON payload into ACP content blocks +
 * the referenced image ids. Image *bytes* are not touched here:
 * the ids are resolved against the upload store by the caller
 * (server side), which validates them and supplies base64.
 *
 * Returns null on malformed JSON; an empty payload is legal (the
 * caller decides whether "nothing at all" is sendable).
 */
export function parseComposerPayload(
  raw: FormDataEntryValue | null,
): { blocks: ContentBlock[]; imageIds: string[] } | null {
  if (typeof raw !== "string" || !raw) return { blocks: [], imageIds: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const text =
    typeof (parsed as { text?: unknown }).text === "string"
      ? ((parsed as { text: string }).text as string).trim()
      : "";
  const blocks: ContentBlock[] = [];
  if (text) blocks.push({ type: "text", text });

  const rawResources = (parsed as { resources?: unknown }).resources;
  if (Array.isArray(rawResources)) {
    for (const r of rawResources) {
      if (!r || typeof r !== "object") continue;
      const path = (r as { path?: unknown }).path;
      const name = (r as { name?: unknown }).name;
      if (typeof path !== "string" || typeof name !== "string") continue;
      blocks.push({
        type: "resource_link",
        // file:// URI per RFC 3986 (three slashes: empty
        // authority + absolute path)
        uri: "file://" + (path.startsWith("/") ? path : "/" + path),
        name,
        mimeType:
          typeof (r as { mimeType?: unknown }).mimeType === "string"
            ? ((r as { mimeType: string }).mimeType as string)
            : undefined,
      });
    }
  }

  const imageIds: string[] = [];
  const rawImages = (parsed as { images?: unknown }).images;
  if (Array.isArray(rawImages)) {
    for (const r of rawImages) {
      if (!r || typeof r !== "object") continue;
      const id = (r as { id?: unknown }).id;
      if (typeof id !== "string" || !ID_RE.test(id)) continue;
      if (!imageIds.includes(id)) imageIds.push(id);
    }
  }
  return { blocks, imageIds };
}

const ID_RE = new RegExp(`^${ID}$`, "i");

/**
 * Build the wire blocks for one resolved upload: the ACP image
 * content block followed by its text marker. Interleaved per
 * image so agents that preserve block order see each label
 * next to its image (pi-acp concatenates all text either way).
 */
export function imageWireBlocks(
  upload: { id: string; mimeType: string; data: string },
): ContentBlock[] {
  return [
    { type: "image", mimeType: upload.mimeType, data: upload.data },
    { type: "text", text: `[Image: ${upload.id}]` },
  ];
}

/**
 * Rewrite the wire text of a user turn for display: resolve
 * every `[Image: <id>]` marker through the injected resolver
 * (the upload store server-side; keeps this module
 * isomorphic and pure). Resolved markers are dropped from the
 * display text (thumbnails render the images — the marker
 * would be redundant) and collected into the returned
 * `images` array; unknown ids keep their raw marker (store
 * wiped → honest degradation, not a silent gap); duplicate
 * markers collapse.
 *
 * The same projection runs on the live path (sendMessage) and
 * on replay (user_message_chunk), so both produce the identical
 * transcript message.
 */
export function rewriteImageMarkers(
  text: string,
  resolve: (id: string) => ImageRef | undefined,
): { text: string; images: ImageRef[] } {
  const images: ImageRef[] = [];
  const seen = new Set<string>();
  const out = text.replace(IMAGE_MARKER_RE, (_all, id: string) => {
    const lower = id.toLowerCase();
    if (seen.has(lower)) return ""; // duplicate marker: collapse
    const ref = resolve(lower);
    if (!ref) return `[Image: ${id}]`; // unknown: keep raw
    seen.add(lower);
    images.push(ref);
    return ""; // resolved: drop from display
  });
  return {
    text: out.replace(/^\n+|\n+$/g, ""),
    images,
  };
}