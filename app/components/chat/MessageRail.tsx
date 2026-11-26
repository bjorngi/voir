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
const MIN_HEIGHT_PCT = 0.9;
/** Below this many messages the rail is noise, not a map. */
const MIN_MESSAGES = 4;
/** ...and below this much overflow it is pointless. */
const MIN_OVERFLOW_PX = 120;

function toneOf(m: ChatMessage): string {
  if (m.role === "user") return "bg-sky-400/80";
  switch (m.kind) {
    case "thought":
      return "bg-neutral-700";
    case "tool":
      return "bg-emerald-400/70";
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
      <div className="pointer-events-auto absolute inset-y-0 right-0 w-3">
      {/* Faint track so the rail reads as a scrollbar and the marks as its
          contents, plus the viewport band: position and extent on screen. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-2 rounded-full bg-white/[0.03]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 rounded-sm border border-white/25 bg-white/[0.10]"
        style={{ top: `${band.top}%`, height: `${band.height}%` }}
      />
      {marks.map((mark, i) => {
        const active = mark.id === activeId;
        return (
          <button
            key={mark.id}
            type="button"
            onClick={() => jump(mark)}
            aria-label={`Jump to message ${i + 1} of ${marks.length}: ${mark.label}`}
            title={mark.label}
            className={
              "absolute right-0 rounded-sm transition-[width,opacity] hover:opacity-100 " +
              mark.tone +
              " " +
              (active ? "w-3 opacity-100" : "w-2 opacity-70")
            }
            style={{ top: `${mark.topPct}%`, height: `${mark.heightPct}%` }}
          />
        );
      })}
      </div>
    </nav>
  );
}
