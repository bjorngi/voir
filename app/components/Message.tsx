import { memo, useState, useMemo, useRef, useEffect, Suspense, lazy } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ChatMessage,
  ToolCallContentBlock,
} from "~/lib/chat-types";
import { buildInlineDiff } from "~/lib/inline-diff";
import {
  matchFenced,
  matchInline,
  isImageRef,
  isDeferred,
  toolImageBlocks,
  INLINE_MODULES,
  type RenderProps,
  type RenderActions,
  type CarrierContext,
  type BlockModule,
} from "~/lib/render/registry";
import { RichContext } from "~/lib/render/rich-context";
import { useDebugPopoverDismiss } from "./DebugPopover";

/**
 * Renders a single message. No bubbles: flat rows, all left-aligned,
 * sharp corners. Tool calls, plans, and thoughts are collapsible
 * outlines. Text uses real markdown via react-markdown + GFM.
 *
 * Each message has a small "···" button in its top-right corner that
 * opens a debug panel with the raw JSON — useful for inspecting
 * tool-call content, message ids, etc.
 *
 * Memoized: a streamed chunk only changes the streaming
 * message's object identity (the server sends fresh objects on
 * the wire), so the rest of a long transcript — every markdown
 * message included — skips re-rendering per chunk. Without
 * this, streaming into a long session re-parsed the whole
 * transcript's markdown on every chunk.
 */
export const MessageBubble = memo(function MessageBubble({
  msg,
  answered = false,
  onSendAnswer,
  onPrefill,
}: {
  msg: ChatMessage;
  /** True when a user message follows this one in the transcript —
   * an ask_user card is then collapsed (its answer already arrived). */
  answered?: boolean;
  /** Send an ask_user answer as a regular chat message. Provided by
   * ChatView; the card formats the text, the send path is the normal
   * composer one (intent=send). */
  onSendAnswer?: (text: string) => void;
  /** Drop text into the composer as an editable draft (rich-card
   *  "prefill" actions — the voice tap-to-edit seam, re-used). */
  onPrefill?: (text: string) => void;
}) {
  if (msg.kind === "text")
    return <Text m={msg} actions={richActions({ onSendAnswer, onPrefill })} />;
  if (msg.kind === "thought") return <Thought m={msg} />;
  if (msg.kind === "tool") {
    // The ask_user extension (sentinel mode) completes the tool call
    // immediately and expects the host to render the questions from
    // rawInput and collect the answer as a follow-up message. That's
    // this card. Anything else (or unparseable input) falls back to
    // the generic tool outline.
    if (msg.title === "ask_user") {
      const questions = parseAskUserInput(msg.rawInput);
      if (questions)
        return (
          <QuestionCard
            m={msg}
            questions={questions}
            answered={answered}
            onSend={onSendAnswer}
          />
        );
    }
    return <Tool m={msg} actions={richActions({ onSendAnswer, onPrefill })} />;
  }
  if (msg.kind === "plan") return <Plan m={msg} />;
  return null;
});

// -----------------------------------------------------------------------
// Debug panel — top-right "···" button, opens raw JSON
// -----------------------------------------------------------------------

function DebugButton({ msg }: { msg: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDebugPopoverDismiss(ref, open, setOpen);

  // Strip the SSE-only `streaming` flag for display; it's noise.
  const { streaming: _streaming, ...rest } = msg as { streaming?: boolean };
  const json = JSON.stringify(rest, null, 2);

  return (
    <div ref={ref} className="absolute right-2 top-1 z-10">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-6 w-6 items-center justify-center font-mono text-[14px] leading-none text-neutral-600 active:bg-neutral-800 active:text-neutral-300"
        aria-label="Debug"
        title="Debug"
      >
        ⋯
      </button>
      {open && (
        <div className="scrollbar-hide absolute right-0 top-7 z-20 max-h-[70vh] w-[min(90vw,28rem)] overflow-auto border border-neutral-700 bg-neutral-950 p-3 text-[11px] shadow-2xl">
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-neutral-800 pb-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">
              Debug
            </span>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(json)}
              className="font-mono text-[10px] uppercase tracking-widest text-neutral-500 active:text-neutral-200"
            >
              Copy
            </button>
          </div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-neutral-400">
            <dt className="text-neutral-600">id</dt>
            <dd className="break-all text-neutral-200">{msg.id}</dd>
            <dt className="text-neutral-600">role</dt>
            <dd>{msg.role}</dd>
            <dt className="text-neutral-600">kind</dt>
            <dd>{msg.kind}</dd>
            {"at" in msg && (
              <>
                <dt className="text-neutral-600">at</dt>
                <dd className="text-neutral-500">
                  {new Date(msg.at).toISOString()} ({msg.at})
                </dd>
              </>
            )}
          </dl>
          <pre className="mt-3 border-t border-neutral-800 pt-2 font-mono text-[11px] leading-relaxed text-neutral-300">
            {json}
          </pre>
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------
// Rich-content registry seam — lazy caches, wrappers, chips. See
// docs/rich-content.md. The registry itself (detection) is pure
// (app/lib/render/registry.ts); this is the client rendering shim.
// -----------------------------------------------------------------------

/** Build the RenderActions for a message. send/prefill flow back
 *  through ChatView's question-card and voice-composer seams. */
const NOOP_ACTIONS: RenderActions = {
  send: () => {},
  prefill: () => {},
  open: () => {},
};
function richActions(o: {
  onSendAnswer?: (text: string) => void;
  onPrefill?: (text: string) => void;
}): RenderActions {
  return {
    send: (text) => o.onSendAnswer?.(text),
    prefill: (text) => o.onPrefill?.(text),
    open: (url) => window.open(url, "_blank", "noopener,noreferrer"),
  };
}

// One lazy component per module id, cached module-scope: React.lazy
// re-runs the factory per call, modules must be created once.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lazyBlocks = new Map<string, React.ComponentType<any>>();
function lazyBlock(m: BlockModule) {
  let c = lazyBlocks.get(m.id);
  if (!c) {
    c = lazy(m.load) as React.ComponentType<any>;
    lazyBlocks.set(m.id, c);
  }
  return c;
}

const lazyChips = new Map<string, React.ComponentType<any>>();
function lazyChip(m: { id: string; load: () => Promise<{ default: React.ComponentType<any> }> }) {
  let c = lazyChips.get(m.id);
  if (!c) {
    c = lazy(m.load) as React.ComponentType<any>;
    lazyChips.set(m.id, c);
  }
  return c;
}
function chipById(id: string) {
  const m = INLINE_MODULES.find((x) => x.id === id);
  return m ? lazyChip(m) : null;
}

/**
 * The fenced-block renderer: registry match → lazy module inside
 * the trust wrapper (collapsible shell for heighted modules), or
 * the plain code fallback — which is also the streaming frame for
 * deferToSettled modules (JSON must never parse half a block).
 */
function RichBlock({
  match,
  lang,
  body,
  streaming,
  actions,
}: {
  match: { module: BlockModule; data: unknown };
  lang: string;
  body: string;
  streaming: boolean;
  actions: RenderActions;
}) {
  const fallback = <PlainCode text={body} />;
  // SSR must not execute module code: mermaid/uPlot/d3 are
  const context: CarrierContext = {
    carrier: { kind: "fenced", lang, body, streaming },
  };
  // browser-only at render time, and React.lazy's import would
  // still be evaluated (and crash) on the server. Transcript SSR
  // shows the plain code; the module swaps in on the client — the
  // showcase shell (full-bleed breakout + ⤢) is pure markup and
  // server-renders, so the affordance is there from first paint.
  if (typeof window === "undefined")
    return match.module.showcase ?
      <RichShowcase
        module={match.module}
        data={match.data}
        context={context}
        actions={actions}
        inline={fallback}
      />
      : fallback;
  if (isDeferred(match, streaming)) return fallback;
  const Component = lazyBlock(match.module);
  const node = (
    <Suspense fallback={fallback}>
      <Component
        data={match.data}
        context={context}
        actions={actions}
        fallback={fallback}
      />
    </Suspense>
  );
  // Showcase modules (the graphics): full-bleed width + the ⤢
  // maximize lightbox. Everything else renders as-is.
  if (!match.module.showcase) return node;
  return (
    <RichShowcase
      module={match.module}
      data={match.data}
      context={context}
      actions={actions}
      inline={node}
    />
  );
}

/**
 * The showcase wrapper: the module breaks out of the transcript's
 * centered column to the full scroll-container width (negative
 * margins mirror the transcript's px-3 / sm:px-4), with a small ⏢
 * pinned top-right that opens the maximize lightbox — the same
 * component re-hosted in a fixed overlay near the viewport size
 * (fixed-frame modules grow to 90vh via the `maximized` prop; the
 * chart's ResizeObserver picks up the wider container on its own).
 * The overlay closes on ⏡ / Escape / backdrop tap.
 */
function RichShowcase({
  module,
  data,
  context,
  actions,
  inline,
}: {
  module: BlockModule;
  data: unknown;
  context: CarrierContext;
  actions: RenderActions;
  inline: ReactNode;
}) {
  const [maximized, setMaximized] = useState(false);
  // Frame height lives HERE — one chrome bar per module (the
  // modules no longer carry their own headers/buttons, so nothing
  // overlaps): module id left; expand/collapse (fixed frames) + ⤢ right.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMaximized(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [maximized]);

  const Component = lazyBlock(module);

  return (
    <div
      className={
        "relative " +
        // break out of the transcript's centered column — the px-3
        // transcript padding at mobile, px-4 at sm+.
        "-mx-3 sm:-mx-4"
      }
      data-testid="rich-showcase"
    >
      <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-950 px-2.5 py-1">
        <span className="font-mono text-[10px] uppercase tracking-widest text-neutral-600">
          {module.id}
        </span>
        <div className="flex items-center gap-1">
          {module.fixedFrame && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-label={expanded ? "Collapse" : "Expand"}
              title={expanded ? "Collapse" : "Expand"}
              className="font-mono text-[10px] uppercase tracking-widest text-neutral-500 active:text-neutral-200"
            >
              {expanded ? "collapse" : "expand"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setMaximized(true)}
            aria-label="Maximize"
            title="Maximize"
            className="px-1 font-mono text-[12px] leading-none text-neutral-400 active:text-neutral-200"
          >
            ⤢
          </button>
        </div>
      </div>
      <div
        style={
          // Only iframe modules need a height clip (their content
          // can't push its own height); everything else is natural.
          module.fixedFrame
            ? { height: expanded ? "70vh" : (module.frameHeight ?? 320) }
            : undefined
        }
      >
        {maximized ? (
          <Suspense fallback={null}>
            <Component
              data={data}
              context={context}
              actions={actions}
              maximized={true}
            />
          </Suspense>
        ) : (
          <Suspense fallback={null}>
            <Component
              data={data}
              context={context}
              actions={actions}
              expanded={module.fixedFrame ? expanded : undefined}
            />
          </Suspense>
        )}
      </div>
      {maximized
        ? createPortal(
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-3 backdrop-blur-sm sm:p-6"
              onClick={() => setMaximized(false)}
              data-testid="rich-maximized"
            >
              <div
                className="max-h-full w-full"
                onClick={(e) => e.stopPropagation()}
              >
                <Suspense fallback={null}>
                  <Component
                    data={data}
                    context={context}
                    actions={actions}
                    maximized={true}
                  />
                </Suspense>
              </div>
              <button
                type="button"
                onClick={() => setMaximized(false)}
                aria-label="Restore"
                title="Restore"
                className="absolute right-3 top-3 border border-neutral-700 bg-neutral-950/80 px-2.5 py-1 font-mono text-[12px] text-neutral-300 active:bg-neutral-800"
              >
                ⏡
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * The plain-code fallback (and the streaming frame). Wraps — no
 * inner scroll (docs/rich-content.md: the page is the scroller).
 */
function PlainCode({ text }: { text: string }) {
  return (
    <pre className="my-2 bg-neutral-900 p-0 font-mono text-[13px]">
      <code className="block whitespace-pre-wrap bg-neutral-900 p-3 font-mono text-[13px] text-neutral-200 [overflow-wrap:anywhere]">
        {text}
      </code>
    </pre>
  );
}

// -----------------------------------------------------------------------
// Text — flat, left-aligned, markdown
// -----------------------------------------------------------------------

function Text({
  m,
  actions,
}: {
  m: ChatMessage & { kind: "text" };
  actions: RenderActions;
}) {
  const isUser = m.role === "user";
  const images = isUser && m.images?.length ? m.images : undefined;
  return (
    <div className={"relative px-4 py-3 " + (isUser ? "bg-neutral-900" : "")}>
      <DebugButton msg={m} />
      {m.text && (
        <div className="text-[15px] leading-relaxed text-neutral-100">
          <Markdown text={m.text} streaming={!!m.streaming} actions={actions} />
        </div>
      )}
      {/* Attached image thumbnails (uploads.server.ts). The
          display text no longer carries the resolved marker
          lines — the images speak for themselves. Tap opens the
          full-size bytes (same URL, new tab). */}
      {images && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {images.map((img) => (
            <a
              key={img.id}
              href={`/api/uploads/${img.id}`}
              target="_blank"
              rel="noopener"
              className="block h-28 w-28 overflow-hidden border border-neutral-700 bg-neutral-800 active:border-neutral-500"
              aria-label={img.name ?? "Attached image"}
            >
              <img
                src={`/api/uploads/${img.id}`}
                alt={img.name ?? "Attached image"}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------
// Thought — collapsible
// -----------------------------------------------------------------------

function Thought({ m }: { m: ChatMessage & { kind: "thought" } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative px-4 py-2">
      <DebugButton msg={m} />
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-baseline gap-2 pr-6 text-left text-[12px] text-neutral-500"
      >
        <span className="font-mono uppercase tracking-wide">
          {m.streaming ? "thinking" : "thought"}
        </span>
        {!open && <span className="truncate text-neutral-600">{oneLine(m.text)}</span>}
        <span className="ml-auto text-neutral-700">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="mt-2 border-l border-neutral-800 pl-3 text-[13px] leading-relaxed text-neutral-400">
          <Markdown text={m.text} streaming={false} actions={NOOP_ACTIONS} />
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------
// Question card — the ask_user host side
// -----------------------------------------------------------------------

/** Parsed ask_user tool input. The extension's wire shape (see its
 * README): one or more questions, each with optional labeled options;
 * questions without options are free-text and answered in the
 * composer, not the card. */
interface AskUserQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/**
 * Validate-and-cast the raw tool input into questions. Returns null
 * for anything that isn't a plausible ask_user payload (unknown tools,
 * partial/streamed args, foreign schemas) — the caller then renders
 * the generic tool outline instead of a broken card.
 */
export function parseAskUserInput(rawInput: unknown): AskUserQuestion[] | null {
  if (!rawInput || typeof rawInput !== "object") return null;
  const questions = (rawInput as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const parsed: AskUserQuestion[] = [];
  for (const q of questions) {
    if (!q || typeof q !== "object") continue;
    const { question, header, options, multiSelect } = q as {
      question?: unknown;
      header?: unknown;
      options?: unknown;
      multiSelect?: unknown;
    };
    if (typeof question !== "string" || !question) continue;
    const opts: AskUserQuestion["options"] = [];
    if (Array.isArray(options)) {
      for (const o of options) {
        if (!o || typeof o !== "object") continue;
        const label = (o as { label?: unknown }).label;
        if (typeof label !== "string" || !label) continue;
        const description = (o as { description?: unknown }).description;
        opts.push({
          label,
          description: typeof description === "string" ? description : undefined,
        });
      }
    }
    parsed.push({
      question,
      header: typeof header === "string" ? header : undefined,
      options: opts,
      multiSelect: multiSelect === true,
    });
  }
  return parsed.length > 0 ? parsed : null;
}

/**
 * The question card. Single single-select question: tap an option →
 * the answer sends immediately (fewest taps on a phone). Everything
 * else (multi-select, several questions): selections collect and a
 * Send button appears. Free-text questions are answered in the
 * composer below — the hint says so.
 *
 * Collapses to a one-line "answered" state once a user message
 * follows the tool call in the transcript (computed by ChatView) or
 * this instance just sent one. Replay-safe: an old card from a
 * session/load re-renders collapsed the same way.
 */
function QuestionCard({
  m,
  questions,
  answered,
  onSend,
}: {
  m: ChatMessage & { kind: "tool" };
  questions: AskUserQuestion[];
  answered: boolean;
  onSend?: (text: string) => void;
}) {
  // Per-question selected option labels, keyed by question index.
  const [selection, setSelection] = useState<Map<number, string[]>>(new Map());
  const [sent, setSent] = useState(false);
  const done = answered || sent;

  const send = (text: string) => {
    if (done || !onSend) return;
    setSent(true);
    onSend(text);
  };

  const pick = (qi: number, label: string) => {
    const q = questions[qi];
    if (!q) return;
    // One single-select question: tap = send. No intermediate state.
    if (questions.length === 1 && !q.multiSelect) {
      send(label);
      return;
    }
    setSelection((prev) => {
      const next = new Map(prev);
      if (q.multiSelect) {
        const cur = next.get(qi) ?? [];
        next.set(
          qi,
          cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
        );
      } else {
        next.set(qi, [label]);
      }
      return next;
    });
  };

  // Every optioned question answered → Send enabled. Questions
  // without options are composer/free-text territory and don't gate
  // the button.
  const answerable = questions.filter((q) => q.options.length > 0);
  const allAnswered =
    answerable.length > 0 &&
    answerable.every((_, qi0) => {
      const qi = questions.indexOf(answerable[qi0]);
      return (selection.get(qi) ?? []).length > 0;
    });
  // Any multi-select or more than one question: collect-then-send
  // mode, so show the button.
  const showSend =
    questions.some((q) => q.multiSelect) || questions.length > 1;

  if (done) {
    return (
      <div className="relative px-4 py-2 text-[12px]">
        <DebugButton msg={m} />
        <span className="font-mono uppercase tracking-wide text-emerald-400">
          ask_user
        </span>{" "}
        <span className="text-neutral-500">— answered in a follow-up message</span>
      </div>
    );
  }

  return (
    <div className="relative border border-neutral-800 bg-neutral-950 px-4 py-3">
      <DebugButton msg={m} />
      <div className="mb-2 font-mono text-[11px] uppercase tracking-wide text-amber-400">
        {m.status === "pending" || m.status === "in_progress"
          ? "asking…"
          : "ask_user"}
      </div>
      {questions.map((q, qi) => (
        <div key={qi} className={qi > 0 ? "mt-3" : ""}>
          {q.header && (
            <div className="font-mono text-[11px] uppercase tracking-wide text-neutral-500">
              {q.header}
            </div>
          )}
          <div className="text-[14px] leading-snug text-neutral-100">
            {q.question}
          </div>
          {q.options.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1.5">
              {q.options.map((o) => {
                const selected = (selection.get(qi) ?? []).includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => pick(qi, o.label)}
                    className={
                      "border px-3 py-2 text-left " +
                      (selected
                        ? "border-amber-500/60 bg-amber-500/10 text-amber-200"
                        : "border-neutral-800 bg-neutral-900 text-neutral-200")
                    }
                  >
                    <span className="block text-[14px] leading-snug">{o.label}</span>
                    {o.description && (
                      <span className="mt-0.5 block text-[12px] leading-snug text-neutral-500">
                        {o.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="mt-1 text-[12px] text-neutral-600">
              Free text — answer in the composer below.
            </div>
          )}
        </div>
      ))}
      {showSend && (
        <button
          type="button"
          disabled={!allAnswered}
          onClick={() => {
            const parts: string[] = [];
            questions.forEach((q, qi) => {
              const sel = selection.get(qi);
              if (!sel?.length) return;
              parts.push(
                questions.length === 1
                  ? sel.join(", ")
                  : `${qi + 1}. ${sel.join(", ")}`,
              );
            });
            if (parts.length > 0) send(parts.join("\n"));
          }}
          className={
            "mt-3 border px-3 py-2 font-mono text-[12px] uppercase tracking-wide " +
            (allAnswered
              ? "border-amber-500/60 bg-amber-500/10 text-amber-200"
              : "border-neutral-800 bg-neutral-900 text-neutral-600")
          }
        >
          Send answers
        </button>
      )}
      <div className="mt-2 text-[11px] text-neutral-600">
        or type your own reply below
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Tool — collapsible outline
// -----------------------------------------------------------------------

function Tool({
  m,
  actions,
}: {
  m: ChatMessage & { kind: "tool" };
  /** Present (unused in v1) — tool buttons/cards arrive on the card
   *  module path, not the outline. Kept in the signature so the
   *  bubble passes one actions shape everywhere. */
  actions?: RenderActions;
}) {
  // Edits (and any tool with a diff) are the point of the
  // transcript — they should be visible inline, not behind a
  // chevron. Other tool output stays collapsible.
  const hasDiff = m.content?.some((c) => c.type === "diff") ?? false;
  const [open, setOpen] = useState(hasDiff);
  const s = statusStyle(m.status);
  // edit/write tools that have a diff pair the diff with a "Successfully
  // replaced ..." status line, which is redundant — the diff already
  // shows what changed. Drop those text blocks.
  const suppressTextStatus =
    hasDiff && (m.toolKind === "edit" || m.toolKind === "write");
  const nonDiffContent = (m.content ?? []).filter(
    (c) => c.type !== "diff" && !(suppressTextStatus && c.type === "content"),
  );
  const hasNonDiff = nonDiffContent.length > 0;
  // Image content blocks render as thumbnails right under the tool
  // header — the `image` module's tool-carrier side (a tool that
  // *returns* an image, e.g. a grafana render, shows it directly,
  // not only inside the collapsed outline).
  const images = toolImageBlocks(m.content);
  return (
    <div className="relative px-4 py-2">
      <DebugButton msg={m} />
      {hasNonDiff && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-baseline gap-2 pr-6 text-left text-[12px]"
          aria-expanded={open}
        >
          <span className={"font-mono uppercase tracking-wide " + s.text}>
            {m.toolKind ?? "tool"}
          </span>
          <span className="truncate font-mono text-[13px] text-neutral-300">
            {m.title}
          </span>
          <span className="ml-auto text-neutral-600">{open ? "−" : "+"}</span>
        </button>
      )}
      {hasDiff && (
        <div className={(hasNonDiff ? "mt-2 " : "") + "text-[12px] text-neutral-400"}>
          {m.content!.map((c, i) => {
            if (c.type !== "diff") return null;
            return (
              <Diff
                key={i}
                path={c.path ?? ""}
                oldText={c.oldText ?? ""}
                newText={c.newText ?? ""}
              />
            );
          })}
        </div>
      )}
      {images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {images.map((img, i) => (
            <a
              key={i}
              href={`data:${img.mimeType ?? "image/png"};base64,${img.data}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block h-32 w-32 overflow-hidden border border-neutral-700 bg-neutral-800 active:border-neutral-500"
            >
              <img
                src={`data:${img.mimeType ?? "image/png"};base64,${img.data}`}
                alt={img.name ?? "Tool image"}
                loading="lazy"
                className="h-full w-full object-cover"
                data-testid="tool-image"
              />
            </a>
          ))}
        </div>
      )}
      {hasNonDiff && open && (
        <div className="mt-2 border-l border-neutral-800 pl-3 text-[12px] text-neutral-400">
          {m.locations && m.locations.length > 0 && (
            <ul className="mb-2 font-mono text-neutral-500">
              {m.locations.map((l, i) => (
                <li key={i} className="truncate">
                  {l.path}
                  {l.line ? `:${l.line}` : ""}
                </li>
              ))}
            </ul>
          )}
          <ToolContent content={nonDiffContent} />
        </div>
      )}
    </div>
  );
}

function ToolContent({ content }: { content: ToolCallContentBlock[] }) {
  return (
    <div className="flex flex-col gap-2">
      {content.map((c, i) => {
        if (c.type === "content" && c.content) {
          if (c.content.type === "text") {
            return (
              <pre
                key={i}
                className="overflow-auto whitespace-pre-wrap font-mono text-[12px] text-neutral-300"
              >
                {c.content.text}
              </pre>
            );
          }
          return (
            <div key={i} className="font-mono text-[11px] uppercase text-neutral-500">
              [{c.content.type}]
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function Diff({ path, oldText, newText }: { path: string; oldText: string; newText: string }) {
  const lines = useMemo(() => buildInlineDiff(oldText, newText), [oldText, newText]);
  return (
    <div className="overflow-hidden border border-neutral-800">
      <div className="bg-neutral-900 px-2 py-1 font-mono text-[11px] text-neutral-500">
        {path}
      </div>
      <pre className="bg-neutral-950 p-2 font-mono text-[12px] leading-snug">
        {lines.map((l, i) => (
          <div
            key={i}
            className={
              l.kind === "del"
                ? "bg-rose-950/40 text-rose-300"
                : l.kind === "add"
                  ? "bg-emerald-950/40 text-emerald-300"
                  : "text-neutral-400"
            }
          >
            <span className="mr-2 select-none text-neutral-600">
              {l.kind === "del" ? "-" : l.kind === "add" ? "+" : " "}
            </span>
            {l.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

// -----------------------------------------------------------------------
// Plan — checklist, all left-aligned
// -----------------------------------------------------------------------

function Plan({ m }: { m: ChatMessage & { kind: "plan" } }) {
  return (
    <div className="relative px-4 py-2 pr-10 text-[13px] text-neutral-300">
      <DebugButton msg={m} />
      <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-neutral-500">
        Plan
      </div>
      <ul className="flex flex-col gap-0.5">
        {m.entries.map((e, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <PlanStatus status={e.status} />
            <span className="flex-1">{e.content}</span>
            {e.priority && (
              <span
                className={
                  "shrink-0 font-mono text-[10px] uppercase " +
                  priorityStyle(e.priority)
                }
              >
                {e.priority}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// -----------------------------------------------------------------------
// Markdown rendering
// -----------------------------------------------------------------------

/**
 * Real markdown via react-markdown + remark-gfm.
 *
 *   - GFM: tables, task lists, strikethrough, autolinks
 *   - Code fences are syntax-highlighted only minimally (monospace);
 *     we don't pull in shiki/highlight.js to keep the bundle small.
 *   - Rich-content seams (docs/rich-content.md): a fenced block is
 *     offered to the module registry before the plain-code render
 *     (mermaid → diagram, ```html → sandboxed app, ```voir-chart →
 *     chart, …); an inline code span is offered to the chip
 *     registry (namespace prefixes like `ha:sensor.x`). No match →
 *     exactly the plain rendering this had before the seam.
 */
function Markdown({
  text,
  streaming,
  actions,
}: {
  text: string;
  streaming: boolean;
  actions: RenderActions;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Reset anchors to inherit color; target external links.
        a: ({ node, ...props }) => (
          <a
            {...props}
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 underline underline-offset-2 hover:text-blue-300"
          />
        ),
        // Inline code: subtle background, not a pill. Namespace
        // spans upgrade to chips (lazy; plain span until loaded —
        // Suspense, not null: the prose must not blink). SSR keeps
        // the plain span: React.lazy boundaries never resolve in
        // streaming SSR — and module components are client-only —
        // so the server must not attempt the upgrade at all.
        code: ({ node, className, children, ...props }) => {
          const isBlock = className?.startsWith("language-");
          if (isBlock) {
            return (
              <code
                className="block whitespace-pre-wrap bg-neutral-900 p-3 font-mono text-[13px] text-neutral-200 [overflow-wrap:anywhere]"
                {...props}
              >
                {children}
              </code>
            );
          }
          const token = typeof children === "string" ? children : String(children ?? "");
          if (typeof window === "undefined") {
            return <InlineCodeSpan text={token} {...(props as object)} />;
          }
          // Namespace modules first (ha:), then bare image refs —
          // a backticked dashboard.png in prose becomes a chip.
          const fileImage = !streaming ? isImageRef(token) : null;
          const chip = fileImage
            ? { module: { id: "file-image" }, ref: fileImage }
            : matchInline(token);
          if (chip && !streaming) {
            const Chip = chipById(chip.module.id) ?? lazyChip(chip.module as never);
            return (
              <Suspense fallback={<InlineCodeSpan text={token} {...(props as object)} />}>
                <Chip ref_={chip.ref} token={token} />
              </Suspense>
            );
          }
          return <InlineCodeSpan text={token} {...(props as object)} />;
        },
        // Fenced blocks: the rich-content seam. Extract the fence
        // (language + body) from the hast node before rendering.
        pre: ({ node, ...props }) => {
          const fence = extractFenceFromNode(node);
          if (fence) {
            const match = matchFenced(fence.lang, fence.body, streaming);
            if (match) {
              return (
                <RichBlock
                  match={match}
                  lang={fence.lang}
                  body={fence.body}
                  streaming={streaming}
                  actions={actions}
                />
              );
            }
          }
          // Plain code (and reserved/unknown languages): wraps,
          // no inner scroll — the transcript page grows.
          return (
            <pre
              className="my-2 bg-neutral-900 p-0 font-mono text-[13px]"
              {...props}
            />
          );
        },
        // Headings: tighter than default
        h1: ({ node, ...props }) => (
          <h1
            className="mt-3 mb-1 text-lg font-semibold text-neutral-100"
            {...props}
          />
        ),
        h2: ({ node, ...props }) => (
          <h2
            className="mt-3 mb-1 text-base font-semibold text-neutral-100"
            {...props}
          />
        ),
        h3: ({ node, ...props }) => (
          <h3
            className="mt-2 mb-1 text-[15px] font-semibold text-neutral-100"
            {...props}
          />
        ),
        h4: ({ node, ...props }) => (
          <h4
            className="mt-2 mb-1 text-[14px] font-semibold text-neutral-100"
            {...props}
          />
        ),
        // Lists: tight
        ul: ({ node, ...props }) => (
          <ul className="my-1 list-disc pl-5" {...props} />
        ),
        ol: ({ node, ...props }) => (
          <ol className="my-1 list-decimal pl-5" {...props} />
        ),
        li: ({ node, ...props }) => (
          <li className="my-0.5" {...props} />
        ),
        // Tables: bordered, no zebra
        table: ({ node, ...props }) => (
          <div className="my-2 overflow-x-auto">
            <table
              className="w-full border-collapse border border-neutral-800 text-[13px]"
              {...props}
            />
          </div>
        ),
        th: ({ node, ...props }) => (
          <th
            className="border border-neutral-800 bg-neutral-900 px-2 py-1 text-left font-medium"
            {...props}
          />
        ),
        td: ({ node, ...props }) => (
          <td className="border border-neutral-800 px-2 py-1" {...props} />
        ),
        // Blockquote: a left border, no italic
        blockquote: ({ node, ...props }) => (
          <blockquote
            className="my-2 border-l-2 border-neutral-700 pl-3 text-neutral-400"
            {...props}
          />
        ),
        // Horizontal rule
        hr: ({ node, ...props }) => (
          <hr className="my-3 border-neutral-800" {...props} />
        ),
        // Paragraphs: tight
        p: ({ node, ...props }) => (
          <p className="my-1.5" {...props} />
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/** Inline code span — exactly what inline code looked like before
 *  the chip seam existed. Also the chips' Suspense fallback. */
function InlineCodeSpan({ text, ...props }: { text: string } & Record<string, unknown>) {
  return (
    <code
      className="rounded-none bg-neutral-800/80 px-1 py-0.5 font-mono text-[13px] text-neutral-200"
      {...props}
    >
      {text}
    </code>
  );
}

/**
 * Extract (lang, body) from a fenced block's hast node —
 * `pre > code[language-… ] > text`. Defensive: anything else
 * (pre without a single code child, multiple children, empty
 * body) returns null and the caller renders the pre untouched.
 */
function extractFenceFromNode(
  node: unknown,
): { lang: string; body: string } | null {
  const n = node as {
    children?: Array<{
      tagName?: string;
      properties?: { className?: unknown };
      children?: Array<{ type?: string; value?: unknown }>;
    }>;
  } | undefined;
  if (!n?.children || n.children.length !== 1) return null;
  const code = n.children[0];
  if (code.tagName !== "code") return null;
  const cls = code.properties?.className;
  const classes = Array.isArray(cls) ? cls : [];
  const langTag = classes.find((c) => typeof c === "string" && c.startsWith("language-")) as string | undefined;
  const body = (code.children ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.value as string)
    .join("");
  if (!langTag || typeof body !== "string") return null;
  return { lang: langTag.slice("language-".length).toLowerCase().trim(), body };
}

function statusStyle(s: "pending" | "in_progress" | "completed" | "failed") {
  return s === "completed"
    ? { text: "text-emerald-400" }
    : s === "failed"
      ? { text: "text-rose-400" }
      : s === "in_progress"
        ? { text: "text-amber-400 animate-pulse" }
        : { text: "text-neutral-500" };
}

function priorityStyle(p: "high" | "medium" | "low") {
  return p === "high"
    ? "text-rose-400"
    : p === "medium"
      ? "text-amber-400"
      : "text-neutral-500";
}

function PlanStatus({ status }: { status?: string }) {
  const sym = status === "completed" ? "✓" : status === "in_progress" ? "◐" : "○";
  const color =
    status === "completed"
      ? "text-emerald-400"
      : status === "in_progress"
        ? "text-amber-400"
        : "text-neutral-600";
  return <span className={"font-mono text-sm " + color}>{sym}</span>;
}

function oneLine(text: string): string {
  const t = text.replace(/\n/g, " ").trim();
  return t.length > 80 ? t.slice(0, 77) + "…" : t;
}
