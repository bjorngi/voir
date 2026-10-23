import type { ActivityRow, ActivityState } from "~/lib/chat-types";
import { shortPath, timeAgo } from "~/lib/format";
import { sessionUrl } from "~/lib/urls";

/**
 * The "Working on" section: the curated shortlist of active
 * sessions with their live state (docs/session-status.md).
 *
 * Shared by the root view (the dashboard — rows carry a ✕ to
 * unstar) and the picker (the fast-switch surface — rows are
 * navigation-only). The rows come from `useSessionStatus` in
 * ChatApp: seeded by the root loader, polled every 2s after.
 */

const ACTIVITY_META: Record<
  ActivityState,
  { label: string; dot: string; text: string }
> = {
  working: {
    label: "working",
    dot: "bg-amber-400 animate-pulse",
    text: "text-amber-300",
  },
  waiting: { label: "waiting", dot: "bg-neutral-400", text: "text-neutral-400" },
  fresh: { label: "new", dot: "bg-neutral-600", text: "text-neutral-500" },
  idle: {
    label: "idle",
    dot: "border border-neutral-600",
    text: "text-neutral-600",
  },
  offline: {
    label: "offline",
    dot: "bg-amber-500/60",
    text: "text-amber-500",
  },
};

function ActivityBadge({ state }: { state: ActivityState }) {
  const m = ACTIVITY_META[state];
  return (
    <span
      className={"inline-flex w-16 shrink-0 items-center gap-1.5 text-[11px] " + m.text}
      title={
        state === "waiting"
          ? "Turn done — waiting for your input"
          : state === "idle"
            ? "Not loaded this server run — no live claim"
            : state === "offline"
              ? "Agent offline (heartbeat failing)"
              : state === "working"
                ? "A turn is in flight"
                : "Created, never prompted"
      }
    >
      <span className={"inline-block h-2 w-2 rounded-full " + m.dot} />
      <span>{m.label}</span>
    </span>
  );
}

export function WorkingOnSection({
  rows,
  onUnstar,
  onPick,
  empty,
}: {
  rows: ActivityRow[];
  /** Present on the dashboard (✕ = unstar); omitted in the picker. */
  onUnstar?: (row: ActivityRow) => void;
  onPick?: () => void;
  /** Empty-state text (dashboard + menu panel). */
  empty?: string;
}) {
  if (rows.length === 0) {
    if (!empty) return null;
    return (
      <section aria-label="Working on" className="border-b border-neutral-900">
        <h2 className="px-4 pb-1 pt-4 text-xs font-medium tracking-wide text-neutral-500">
          Working on
        </h2>
        <p className="px-4 pb-4 text-sm text-neutral-600">{empty}</p>
      </section>
    );
  }
  return (
    <section aria-label="Working on" className="border-b border-neutral-900">
      <h2 className="px-4 pb-1 pt-4 text-xs font-medium tracking-wide text-neutral-500">
        Working on
      </h2>
      <ul className="pb-2">
        {rows.map((row) => (
          <li key={row.folder + "/" + row.sessionId} className="relative">
            <a
              href={sessionUrl(row.folder, row.sessionId)}
              onClick={onPick}
              className={
                "flex items-center gap-2 py-2.5 pl-4 text-sm active:bg-neutral-900 " +
                (onUnstar ? "pr-10" : "pr-3")
              }
            >
              <ActivityBadge state={row.state} />
              <span className="min-w-0 flex-1 truncate text-neutral-200">
                {row.title ?? row.sessionId.slice(0, 8)}
              </span>
              {row.queued > 0 && (
                <span
                  title={`${row.queued} prompt(s) queued for delivery between turns`}
                  className="shrink-0 rounded border border-neutral-800 px-1 py-0.5 font-mono text-[10px] text-neutral-400"
                >
                  queued {row.queued}
                </span>
              )}
              <span className="shrink-0 font-mono text-[11px] text-neutral-500">
                {shortPath(row.folder)}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-neutral-600">
                {timeAgo(row.lastActivityAt)}
              </span>
            </a>
            {onUnstar && (
              <button
                type="button"
                onClick={() => onUnstar(row)}
                aria-label="Remove from Working on"
                title="Remove from Working on"
                className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-neutral-600 active:bg-neutral-900"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}