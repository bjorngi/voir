/**
 * voir-card (docs/rich-content.md, module 6): dense summary cards
 * from machine lanes — checkup verdicts, briefings, alerts. The
 * interactive generalization of the ask_user question card:
 * verdict pill, key/value rows with deltas and sparklines, and
 * action buttons that send / prefill a message or open a link.
 */
import type { ReactNode } from "react";
import { parseCard, sparkPoints, type CardData, type PillTone } from "../parse";
import type { RenderActions, RenderProps } from "../registry";

/**
 * Render a card. The validator runs again (same function as the
 * registry sniff, so a rendered card is always a valid card) —
 * null re-renders the raw body as code via the fallback.
 */
export default function Card({ data, context, actions, fallback }: RenderProps<CardData> & { fallback?: ReactNode }) {
  const body =
    context.carrier.kind === "fenced" ? context.carrier.body : "";
  const card = parseCard(body);
  if (!card) return <>{fallback ?? null}</>;
  return <CardView card={card} actions={actions} />;
}

function CardView({ card, actions }: { card: CardData; actions: RenderActions }) {
  return (
    <div className="border border-neutral-800 bg-neutral-900">
      {card.title && (
        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
          <span className="text-[13px] font-semibold text-neutral-100">{card.title}</span>
          {card.pill && <Pill text={card.pill.text} tone={card.pill.tone} />}
        </div>
      )}
      {card.rows && (
        <ul className="divide-y divide-neutral-800/60">
          {card.rows.map((r, i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-1.5 text-[13px]">
              <span className="min-w-0 flex-1 truncate text-neutral-400">{r.k}</span>
              {r.spark && <Spark values={r.spark} />}
              <span className="font-mono text-neutral-100">{r.v}</span>
              {r.delta && (
                <span className={
                  "shrink-0 font-mono text-[11px] " +
                  (r.delta.startsWith("-") ? "text-emerald-400" : "text-neutral-500")
                }>
                  {r.delta}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {card.actions && card.actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-neutral-800 p-2">
          {card.actions.map((a, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                if (a.kind === "send") actions.send(a.value);
                else if (a.kind === "prefill") actions.prefill(a.value);
                else if (isHttpUrl(a.value)) actions.open(a.value);
              }}
              className={
                "border px-2.5 py-1 text-[12px] font-medium transition-colors " +
                (a.kind === "link"
                  ? "border-neutral-700 bg-transparent text-blue-400 active:bg-neutral-800"
                  : "border-neutral-600 bg-transparent text-neutral-100 active:bg-neutral-800")
              }
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Pill({ text, tone }: { text: string; tone?: PillTone }) {
  const cls =
    tone === "good" ? "text-emerald-300 border-emerald-400/40"
    : tone === "warn" ? "text-amber-300 border-amber-400/40"
    : tone === "bad" ? "text-rose-300 border-rose-400/40"
    : tone === "info" ? "text-blue-300 border-blue-400/40"
    : "text-neutral-300 border-neutral-600";
  return (
    <span className={"rounded-none border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest " + cls}>
      {text}
    </span>
  );
}

/** Tiny inline sparkline: 100×24 SVG polyline, accent color. */
export function Spark({
  values,
  width = 88,
  height = 24,
}: {
  values: Array<[number, number] | number>;
  width?: number;
  height?: number;
}) {
  const pts = sparkPoints(values, width, height);
  if (pts.length === 0) return null;
  const line = pts.map(([x, y]) => `${x},${y}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 text-amber-400"
      aria-hidden="true"
    >
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx={last[0]} cy={last[1]} r="2" fill="currentColor" />
    </svg>
  );
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}