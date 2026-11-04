import type { ReactNode } from "react";
import type {
  ChatMessage,
  ContentBlock,
  ToolCallContentBlock,
} from "~/lib/chat-types";
import { parseCard, parseChart } from "./parse";

/**
 * The rich-content module registry (docs/rich-content.md) — the
 * seam between "content an agent emitted" and "how voir renders
 * it".
 *
 * Carriers → detection → module. Carriers are channels that
 * already exist (fenced blocks in any text, inline namespace
 * code spans, ACP tool content blocks); a module is a small
 * renderer with a detector. First match wins; **no match = the
 * carrier's honest fallback** (code block, tool outline, raw
 * span — never a dropped message).
 *
 * Modules are isomorphic-safe: the registry itself is pure
 * (detection runs server-side in tests and client-side in
 * Message.tsx); the module components are client-only (lazy).
 */

// ── Carrier contexts ────────────────────────────────────────────────

/** A fenced code block parsed out of markdown text. */
export interface FencedCarrier {
  kind: "fenced";
  /** The fence's language tag, lowercased, e.g. "mermaid", "voir-card". */
  lang: string;
  /** The fence body (the agent's full block, not yet rendered). */
  body: string;
  /** True while the agent is still streaming this message —
   *  renderers that need complete input (all of the JSON/graphic
   *  ones) show the plain code until settled. */
  streaming: boolean;
}

/** An inline code span inside prose (the chip seam). */
export interface InlineCarrier {
  kind: "inline";
  /** The span text, e.g. "ha:sensor.kitchen_temperature". */
  token: string;
  streaming: boolean;
}

/** Tool-call content or rawInput (the question-card seam). */
export interface ToolCarrier {
  kind: "tool";
  toolName: string;
  toolKind?: string;
  status: string;
  /** The tool's structured content blocks (image/diff/…). */
  content?: ToolCallContentBlock[];
  rawInput?: unknown;
  streaming: boolean;
}

export type CarrierContext =
  | { carrier: FencedCarrier }
  | { carrier: InlineCarrier }
  | { carrier: ToolCarrier };

/** Actions a renderer may take (see docs/rich-content.md — Interaction). */
export interface RenderActions {
  /** Send `text` as a user message now (card "send" actions). */
  send: (text: string) => void;
  /** Drop `text` into the composer as an editable draft (card
   *  "prefill" actions — the voice tap-to-edit seam). */
  prefill: (text: string) => void;
  /** Open a URL (card "link" actions). */
  open: (url: string) => void;
}

export interface RenderProps<T = unknown> {
  /** The parsed payload — a module's own schema; renderers
   *  validate. (Registry detection is cheap-sniffing; the module
   *  re-validates and can still bail to its fallback.) */
  data: T;
  /** Raw carrier coordinates (streaming flag, tool name, …). */
  context: CarrierContext;
  actions: RenderActions;
  /** True while the module is shown in the maximize lightbox
   *  (viewport-sized) — fixed-frame modules size themselves up. */
  maximized?: boolean;
  /** The shell's expand/collapse toggle (fixed-frame modules:
   *  the inline frame height toggles frameHeight ↔ 70vh). */
  expanded?: boolean;
  /** The inline rendering, for the module's own bail-out path. */
  fallback?: ReactNode;
}

// ── Block modules ───────────────────────────────────────────────────

/**
 * A block-level renderer. `detect` sees a parsed view of the
 * carrier so JSON-family modules can sniff payloads; a match
 * means the registry hands rendering over. The module still
 * re-validates `data` (detection may be looser than the schema).
 */
export interface BlockModule {
  id: string;
  /** Fence language tags this module claims (lowercased). */
  langs?: string[];
  /** Optional JSON sniff for JSON-family blocks — returns the
   *  parsed value (passed to the component) or null to not match. */
  sniff?: (lang: string, body: string) => unknown | null;
  /**
   * Graphic module: renders full-bleed (breaks out of the
   * transcript column) and gets the ⤢ maximize button — a lightbox
   * overlay that re-hosts the module at near-viewport size. Cards,
   * tables and inline things stay in-column.
   */
  showcase?: boolean;
  /**
   * The module's own AI documentation — the emission contract the
   * nudge assembles into voir-attached sessions' system prompts
   * (docs/rich-content.md — Nudging). One source of truth: a new
   * module that doesn't ship a guide is invisible to agents.
   */
  guide?: string;
  /** True when the renderer is an iframe whose content can't push
   *  its own height (html/d3 apps) — the only modules that get the
   *  fixed frame + expand/collapse shell. Everything else renders
   *  at natural height inside the page scroll (no inner
   *  scrollbars — two fingers / finger scroll the transcript). */
  fixedFrame?: boolean;
  /** Frame height for fixedFrame modules (px). */
  frameHeight?: number;
  /** Lazy component (React.lazy-friendly module default export).
   *  Typed loose here (`data` is module-validated); the registry
   *  hands over unknown and the module's own validator narrows it. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  load: () => Promise<{ default: React.ComponentType<any> }>;
  /** True when the renderer can't take streaming input (all of
   *  the JSON/graphic ones) — the registry shows plain code and
   *  swaps the module in on settle. */
  deferToSettled: boolean;
}

// ── Inline modules (the chip seam) ──────────────────────────────────

/**
 * An inline renderer: claims namespace-prefixed spans inside
 * prose. Chips render within the text flow — no block wrapper,
 * no collapsing; read-only (docs/rich-content.md — Interaction).
 */
export interface InlineModule {
  id: string;
  /** Token prefix (e.g. "ha:"); case-insensitive. */
  prefix: string;
  /** The module's own AI documentation (see BlockModule.guide). */
  guide?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  load: () => Promise<{ default: React.ComponentType<any> }>;
}

export interface InlineProps {
  /** Everything after the prefix, e.g. "sensor.kitchen_temperature". */
  ref_: string;
  /** The full original token. */
  token: string;
}

// ── The registries (ordered; first match wins) ──────────────────────

// Declared in dependency-friendly order: specific JSON modules,
// then the lang-keyed graphic modules, then the catch-alls.
export const BLOCK_DETECTIONS: BlockModule[] = [
  {
    id: "card",
    langs: ["voir-card"],
    sniff: (lang, body) => sniffCard(lang, body),
    guide:
      'Summary card from JSON: title, pill {text, tone: good|warn|bad|info}, rows [{k, v, delta, spark:[…≥2 numbers]}], actions [{label, kind:"send"|"prefill"|"link", value}]. "send" sends value as the user\'s message on tap (label must tell the truth; value is a self-contained instruction). "prefill" drafts it editable. "link" opens the URL. Keep it dense — verdicts, metrics, briefings; one idea per card; never wrap ordinary prose in one.',
    load: () => import("./modules/card"),
    deferToSettled: true,
  },
  {
    id: "chart",
    langs: ["voir-chart"],
    sniff: (lang, body) => sniffChart(lang, body),
    guide:
      'Chart from JSON: title, unit, type:"line"|"area", series [{label, points:[[epochMs, value],…≥2]}]. Emit queried series data; timestamp gaps render as gaps; the host owns axes, theme and interaction — no styling in the block.',
    load: () => import("./modules/chart"),
    deferToSettled: true,
    showcase: true,
  },
  {
    id: "mermaid",
    langs: ["mermaid"],
    guide:
      'Prefer for standard diagrams (flowchart, sequence, state, ER, gantt) — compact and renders as a graphic.',
    load: () => import("./modules/mermaid"),
    deferToSettled: true,
    showcase: true,
  },
  {
    id: "svg",
    langs: ["svg"],
    load: () => import("./modules/svg"),
    deferToSettled: true,
    showcase: true,
  },
  {
    id: "html",
    langs: ["html", "htm"],
    guide:
      'Single-file HTML app in a sandboxed iframe (opaque origin; inline script/style ok; cdn.jsdelivr.net / esm.sh / unpkg.com reachable for import maps and React). Build interactive mini-apps: calculators, comparisons, dashboards, forms.',
    load: () => import("./modules/html"),
    deferToSettled: true,
    fixedFrame: true,
    frameHeight: 320,
    showcase: true,
  },
  {
    id: "d3",
    langs: ["d3"],
    guide:
      'Your JavaScript runs in a sandbox with d3 v7 preloaded — opaque origin, no network to the host, so embed all data inline (const data = …). `d3` and `#viz` are in scope; size to innerWidth/innerHeight; render errors show as red text. For bespoke visuals (force graphs, treemaps, custom plots) — only when no structured block fits.',
    load: () => import("./modules/d3"),
    deferToSettled: true,
    fixedFrame: true,
    frameHeight: 340,
    showcase: true,
  },
  {
    id: "table",
    langs: ["csv", "tsv"],
    guide:
      'CSV/TSV with a header row renders as a table; numeric columns get sparklines.',
    load: () => import("./modules/table"),
    deferToSettled: true,
  },
  {
    id: "image",
    langs: ["image", "img"],
    guide:
      'A data:image/…;base64,… body renders as an image (rare — prefer backticked worktree paths).',
    load: () => import("./modules/image"),
    deferToSettled: true,
  },
];

export const INLINE_MODULES: InlineModule[] = [
  {
    id: "ha-entity",
    prefix: "ha:",
    guide:
      'Inline `ha:<entity_id>` spans render as entity chips inside prose (live state when the host has HA access). Read-only — interaction lives on cards.',
    load: () => import("./modules/ha-entity"),
  },
  {
    id: "file-image",
    prefix: "file:",
    guide:
      'Backtick image WORKTREE paths you produced (`dashboard.png`, `figs/loss.png`) → inline thumbnails; `file:<path>` is the explicit form. Mention paths in backticks when you generate visuals.',
    load: () => import("./modules/file-image"),
  },
];

/**
 * Assembled nudge (docs/rich-content.md — Nudging): the always-on
 * system-prompt text for voir-attached sessions, derived from each
 * module's own guide so the prompt can never drift from the
 * registry. The voir-rich extension appends this under VOIR=1.
 */
export function assembleNudge(): string {
  const guides = [
    ...BLOCK_DETECTIONS.map((m) => m.guide),
    ...INLINE_MODULES.map((m) => m.guide),
  ].filter((g): g is string => !!g);
  return [
    "voir (this session's chat host) renders rich blocks in replies:",
    ...guides.map((g, i) => `${i + 1}. ${g}`),
    'USE THE NAMED FENCE TAGS, never a generic ```json block: when the user asks for "a card", "summarize as a card", "a chart", "a graph" or "a diagram", the fence tag must be voir-card / voir-chart / mermaid / d3 — the host renders those; ```json stays plain code. Example card:\n```voir-card\n{ "title": "Cluster status", "pill": {"text":"healthy","tone":"good"}, "rows": [{"k":"disk","v":"42%"}], "actions": [{"label":"Ack","kind":"send","value":"acknowledged"}] }\n```',
    "Render when the deliverable helps; keep fences complete (partials show as code until the turn settles). Full schemas + examples: read the voir-rich skill.",
  ].join("\n");
}

/**
 * Extensions the file-image inline module thumbnails (the same
 * mime table files.server.imageMime serves via /api/folder-file
 * raw mode — plus svg, safe inside <img>). Path-like tokens only:
 * no spaces, ≤120 chars, at least one directory-ish char or a
 * plausible basename.
 */
export const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif|svg)$/i;

/**
 * True when an inline code span looks like a worktree image
 * reference worth thumbnailing — the file-image seam's detector
 * (used with or without the explicit `file:` prefix: a bare
 * backticked "covid-dashboard.png" qualifies). Tokens with a
 * different NAMESPACE prefix ("ha:") stay with the prefix
 * modules; `file:` is the explicit opt-in that strips through.
 */
export function isImageRef(token: string): string | null {
  const t = token.trim();
  const path = (t.startsWith("file:") ? t.slice(5) : t).trim();
  if (!path || path.length > 120 || /\s/.test(path)) return null;
  // Other namespaced spans belong to their prefix module, not us.
  if (path.includes(":")) return null;
  if (!IMAGE_EXT_RE.test(path)) return null;
  // Reject url-ish tokens (the chip resolves worktree-relative).
  if (/^[a-z]+:\/\//i.test(path) || path.startsWith("//")) return null;
  return path;
}

/**
 * Fence language tags that must NOT be claimed: generic code,
 * scripts, styles, and the plain data the transcript is for.
 * The detector consults this before the module list so
 * ```typescript / ```shell / ```json never route to a renderer
 * by accident.
 */
const RESERVED_LANGS = new Set([
  "typescript", "ts", "tsx", "javascript", "js", "jsx", "mjs", "cjs",
  "python", "py", "ruby", "rb", "rust", "go", "java", "kotlin", "swift",
  "c", "cpp", "csharp", "php", "bash", "sh", "shell", "zsh", "nix",
  "json", "jsonc", "yaml", "yml", "toml", "ini", "sql", "diff", "patch",
  "text", "txt", "md", "markdown", "log", "console", "dockerfile",
  "makefile", "cmake", "xml", "css",
]);

/**
 * Match a fenced block against the registry. Returns the module
 * id + parsed sniff data, or null when no module claims it (the
 * caller renders plain code).
 */
/**
 * Match a fenced block against the registry. Returns the module
 * id + parsed sniff data, or null when no module claims it (the
 * caller renders plain code).
 *
 * Low-priority shape fallback: a plain ```json block whose payload
 * matches a module's schema (card, chart) is claimed by that
 * module. Agents reliably know the structured shapes but not
 * always the fence tag under prompting; a card-shaped JSON is a
 * card. True generic JSON (anything the validators reject) stays
 * code.
 */
export function matchFenced(
  lang: string,
  body: string,
  streaming: boolean,
): { module: BlockModule; data: unknown } | null {
  const l = lang.toLowerCase().trim();
  for (const m of BLOCK_DETECTIONS) {
    if (!m.langs?.includes(l)) continue;
    if (m.sniff) {
      const parsed = m.sniff(l, body);
      if (parsed === null) continue; // e.g. malformed JSON → code block
      return { module: m, data: parsed };
    }
    return { module: m, data: body };
  }
  if (l === "json") {
    // Shape-sniff in registry order (card before chart matches
    // BLOCK_DETECTIONS' order too).
    for (const m of BLOCK_DETECTIONS) {
      if (!m.sniff) continue;
      const parsed = m.sniff("json", body);
      if (parsed !== null) return { module: m, data: parsed };
    }
  }
  return null;
}

/**
 * Match an inline span against the chip registry. Returns the
 * module + the ref (everything after the prefix), or null —
 * inline spans that don't match a namespace stay inline code
 * (the default rendering).
 */
export function matchInline(
  token: string,
): { module: InlineModule; ref: string } | null {
  for (const m of INLINE_MODULES) {
    if (token.toLowerCase().startsWith(m.prefix)) {
      const ref = token.slice(m.prefix.length);
      if (ref) return { module: m, ref };
    }
  }
  return null;
}

/**
 * The streaming rule, shared everywhere: a module that
 * `deferToSettled`s renders as plain code until the message stops
 * streaming. JSON parsers must never run on half a block.
 */
export function isDeferred(match: { module: BlockModule }, streaming: boolean): boolean {
  return streaming && match.module.deferToSettled;
}

// ── JSON sniffs (cheap shape checks, not full validation) ───────────

/** voir-card / voir-chart sniffs delegate to the shared validators
 *  in ./parse.ts — detection and schema are the same function, so
 *  a module can never render a payload its validator rejected. */
/** voir-card sniff → parseCard (null = render plain code). */
function sniffCard(lang: string, body: string): unknown | null {
  return parseCard(body);
}

/** voir-chart: object with a series array of {label, points}. */
/** voir-chart sniff → parseChart (null = render plain code). */
function sniffChart(lang: string, body: string): unknown | null {
  return parseChart(body);
}

// ── Tool content blocks (image blocks today) ────────────────────────

/**
 * True when a tool message carries structured content a module
 * should render — image content blocks (the `image` module).
 * Diffs and text keep the existing Tool outline rendering.
 */
export function toolImageBlocks(content: ToolCallContentBlock[] | undefined): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const b of content) {
    if (b?.type === "content" && b.content?.type === "image" && typeof (b.content as { data?: unknown }).data === "string") {
      out.push(b.content);
    }
  }
  return out;
}

/** Extract fenced blocks + inline chips for the registry from a
 *  markdown message. Exported for tests (the seam Message.tsx
 *  uses via react-markdown's components instead — this helper
 *  backs the test matrix). */
export function extractFenced(text: string): Array<{ lang: string; body: string }> {
  const out: Array<{ lang: string; body: string }> = [];
  const re = /```([A-Za-z0-9_-]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)))
    out.push({ lang: m[1].toLowerCase(), body: (m[2] ?? "").replace(/\n$/, "") });
  return out;
}
