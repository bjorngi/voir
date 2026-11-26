/**
 * MessageRail — a minimap of the conversation.
 *
 * A transcript can be thousands of pixels tall (a replayed session, a long
 * turn), and the native scrollbar is hidden (`scrollbar-hide`) because on a
 * phone it is a 2px sliver you cannot hit. This rail is the answer: one mark
 * per message, positioned and sized like a VS Code minimap — but with no
 * text, just colour-coded bars, so the shape of the conversation is readable
 * at a glance and any message is one tap away.
 *
 * Colour answers "who said it", the only question that matters when hunting:
 *
 *   sky      you (a user turn)
 *   grey     agent prose
 *   dim grey thinking — deliberately quiet, it is not a message
 *   emerald  tool calls
 *   violet   plans
 *
 * The translucent band is the viewport: where you are and how much is on
 * screen. It renders nothing until there is enough transcript to be worth a
 * map (a few messages and more than ~1.2 screens of content), and it sits in
 * the transcript's padding instead of narrowing the text column.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "~/lib/chat-types";
import { msgDomId } from "~/lib/urls";

type Mark = {
  id: string;
  /** Scroll offset (px) of the message top, inside the scroller. */
  offset: number;
  topPct: number;
  heightPct: number;
  tone: string;
  label: string;
};

/** A mark never gets thinner than this fraction of the rail (~2px), so a
 *  one-line thought is still visible and clickable. */
const MIN_HEIGHT_PCT = 1.1;

/**
 * Kinds that do not get a mark.
 *
 * Tool calls are the bulk of a long agent session — a turn can be twenty
 * tool calls around three paragraphs of prose — and they are the thing you
 * are least likely to hunt for by scrolling. Leaving them in turned the
 * rail into a solid emerald column where the messages you actually wanted
 * were single-pixel slivers. The map is of the *conversation*: your turns,
 * the agent's replies, its thinking, its plans.
 *
 * (Tool calls keep their traces: filtering here is presentation only, the
 * transcript and the deep links are unchanged.)
 */
const HIDDEN_KINDS: ReadonlySet<string> = new Set(["tool"]);
/** Below this many messages the rail is noise, not a map. */
const MIN_MESSAGES = 4;
/** ...and below this much overflow it is pointless. */
const MIN_OVERFLOW_PX = 120;

function toneOf(m: ChatMessage): string {
  if (m.role === "user") return "bg-sky-400/80";
  switch (m.kind) {
    case "thought":
      return "bg-neutral-700";
    case "plan":
      return "bg-violet-400/70";
    case "error":
      return "bg-rose-400/60";
    default:
      return "bg-neutral-400/70";
  }
}

function snippetOf(m: ChatMessage): string {
  // Not every kind carries text (tools carry title/status, busy/info/
  // control carry flags), so read defensively rather than narrowing the
  // whole union.
  const anyMsg = m as {
    text?: string;
    title?: string;
    status?: string;
  };
  const raw =
    m.kind === "tool"
      ? `${anyMsg.title ?? "tool"}${anyMsg.status ? ` (${anyMsg.status})` : ""}`
      : (anyMsg.text ?? "").replace(/\s+/g, " ").trim();
  const text = raw.length > 70 ? raw.slice(0, 70) + "…" : raw;
  if (m.role === "user") return `You: ${text}`;
  if (m.kind === "thought") return `Thinking: ${text}`;
  return text || m.kind;
}

export function MessageRail({
  scrollRef,
  messages,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  messages: ChatMessage[];
}) {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [band, setBand] = useState({ top: 0, height: 0 });
  const [activeId, setActiveId] = useState<string | null>(null);
  const raf = useRef<number | null>(null);
  // Scrubbing: pressing the strip anywhere (not just on a mark) moves the
  // viewport proportionally, and dragging keeps moving it. A press that
  // never moves still lands on the mark under the finger as a click.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef({ active: false, moved: false });

  /** Read the DOM once and turn message elements into rail geometry. */
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const total = el.scrollHeight;
    const overflow = total - el.clientHeight;
    if (messages.length < MIN_MESSAGES || overflow < MIN_OVERFLOW_PX) {
      setMarks((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    const viewportTop = el.getBoundingClientRect().top;
    const next: Mark[] = [];
    for (const m of messages) {
      if (HIDDEN_KINDS.has(m.kind)) continue;
      const node = document.getElementById(msgDomId(m.id));
      if (!node || !el.contains(node)) continue;
      const rect = node.getBoundingClientRect();
      const offset = rect.top - viewportTop + el.scrollTop;
      next.push({
        id: m.id,
        offset,
        topPct: (offset / total) * 100,
        heightPct: Math.max((rect.height / total) * 100, MIN_HEIGHT_PCT),
        tone: toneOf(m),
        label: snippetOf(m),
      });
    }
    setMarks(next);
  }, [messages, scrollRef]);

  /** Cheap on every scroll frame: only the viewport band moves. */
  const measureBand = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const total = el.scrollHeight || 1;
    const top = el.scrollTop;
    setBand({
      top: (top / total) * 100,
      height: Math.min(100, (el.clientHeight / total) * 100),
    });
    // "Where am I" for the highlight: the last mark at or above the top.
    setActiveId((prev) => {
      const el2 = scrollRef.current;
      if (!el2) return prev;
      let current: string | null = null;
      for (const mark of marks) {
        if (mark.offset <= top + 8) current = mark.id;
        else break;
      }
      return current ?? prev;
    });
  }, [marks, scrollRef]);

  // Re-measure when the transcript changes, on resize, and once more after
  // layout settles (fonts, images inside rich content, code blocks growing).
  useEffect(() => {
    measure();
    measureBand();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    const settle = setTimeout(() => {
      measure();
      measureBand();
    }, 400);
    return () => {
      ro.disconnect();
      clearTimeout(settle);
    };
  }, [measure, measureBand, messages.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (raf.current !== null) return;
      raf.current = requestAnimationFrame(() => {
        raf.current = null;
        measureBand();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [measureBand, scrollRef]);

  /** Scroll so that `clientY` maps to the same fraction of the transcript. */
  const scrollToFraction = useCallback(
    (clientY: number) => {
      const el = scrollRef.current;
      const strip = stripRef.current;
      if (!el || !strip) return;
      const r = strip.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
      el.scrollTop = f * Math.max(0, el.scrollHeight - el.clientHeight);
    },
    [scrollRef],
  );

  const jump = (mark: Mark) => {
    const el = scrollRef.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({
      top: Math.max(0, mark.offset - 8),
      behavior: reduce ? "auto" : "smooth",
    });
  };

  if (marks.length === 0) return null;

  return (
    // Aligned to the reading measure, not the window edge: on a laptop the
    // text column is centred with wide margins, and a scrollbar 350px away
    // from the text does not read as a map of it.
    <nav
      aria-label="Messages"
      className="pointer-events-none absolute inset-y-0 left-1/2 z-10 w-full max-w-3xl -translate-x-1/2 select-none lg:max-w-4xl 2xl:max-w-5xl"
    >
      {/* Hit strip: 24px wide whatever the visual width, so a 3px slit is
          still a comfortable tap target. The visual parts (track, band,
          marks) are right-aligned and widen on hover or press — the rail
          "slides out" under your finger. */}
      <div
        ref={stripRef}
        className="group pointer-events-auto absolute inset-y-0 right-0 w-6 cursor-pointer"
        onPointerDown={(e) => {
          drag.current = { active: true, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
          scrollToFraction(e.clientY);
        }}
        onPointerMove={(e) => {
          if (!drag.current.active) return;
          drag.current.moved = true;
          scrollToFraction(e.clientY);
        }}
        onPointerUp={() => {
          drag.current.active = false;
        }}
        onPointerCancel={() => {
          drag.current.active = false;
        }}
      >
      {/* Faint track so the rail reads as a scrollbar and the marks as its
          contents, plus the viewport band: position and extent on screen. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-[3px] rounded-full bg-white/[0.06] transition-[width] duration-150 group-hover:w-3.5 group-active:w-3.5"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute right-0 w-[3px] rounded-sm border border-white/30 bg-white/[0.14] transition-[width] duration-150 group-hover:w-3.5 group-active:w-3.5"
        style={{ top: `${band.top}%`, height: `${band.height}%` }}
      />
      {marks.map((mark, i) => {
        const active = mark.id === activeId;
        return (
          <button
            key={mark.id}
            type="button"
            onClick={() => {
              // A press that turned into a drag already scrolled; do not
              // also snap to the mark it started on.
              if (drag.current.moved) {
                drag.current.moved = false;
                return;
              }
              jump(mark);
            }}
            aria-label={`Jump to message ${i + 1} of ${marks.length}: ${mark.label}`}
            title={mark.label}
            className="absolute right-0 w-6"
            style={{ top: `${mark.topPct}%`, height: `${mark.heightPct}%` }}
          >
            <span
              aria-hidden
              className={
                "absolute inset-y-0 right-0 rounded-sm transition-[width,opacity] duration-150 " +
                mark.tone +
                " " +
                (active
                  ? "w-[3px] opacity-100 group-hover:w-3 group-active:w-3"
                  : "w-[3px] opacity-60 group-hover:w-2.5 group-active:w-2.5")
              }
            />
          </button>
        );
      })}
      </div>
    </nav>
  );
}
