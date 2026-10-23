/**
 * The page header: a status dot + label, and the view toggles
 * on the right (working-on star, voice-mode mic, push bell)
 * that end in the reload and menu buttons. The dot pulses
 * amber while a turn is in flight; otherwise it sits dim.
 *
 * Installed-PWA affordances (there is no browser chrome to lean
 * on in standalone): a reload button, and — when `home` is set —
 * the label itself becomes a link back to the root folders
 * view.
 */
import { useEffect, useState } from "react";
import type { SessionStatus } from "~/lib/chat-types";
import { postSessionStatus } from "~/lib/hooks";
import type { PushState } from "~/lib/use-push";

/**
 * The working-on star (docs/session-status.md): toggles the
 * session's `active` status. Optimistic — the loader re-stamps
 * on navigation; a failed POST self-heals on the next snapshot
 * poll. On an archived session the dim star acts as "make
 * active" (a deliberate dig-out un-archives).
 */
function StatusStar({
  status,
  folder,
  sessionId,
}: {
  status: SessionStatus | undefined;
  folder: string;
  sessionId: string;
}) {
  const [current, setCurrent] = useState<SessionStatus | undefined>(status);
  useEffect(() => setCurrent(status), [status]);
  const active = current === "active";
  const toggle = () => {
    const next = active ? "none" : "active";
    setCurrent(next === "none" ? undefined : next);
    postSessionStatus(folder, sessionId, next);
  };
  return (
    <>
      {current === "archived" && (
        <span
          title="Archived — hidden from lists; the star re-activates it"
          className="shrink-0 select-none rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500"
        >
          archived
        </span>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-pressed={active}
        aria-label={active ? "Remove from Working on" : "Add to Working on"}
        title={active ? "Remove from Working on" : "Add to Working on"}
        className={
          "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded active:bg-neutral-900 " +
          (active ? "text-amber-300" : "text-neutral-600")
        }
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill={active ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      </button>
    </>
  );
}

export function Header({
  label,
  busy,
  home,
  menuOpen,
  onMenu,
  voice,
  star,
  push,
}: {
  label: string;
  busy?: boolean;
  /** When true, the label is rendered as a link back to "/".
 * Pass it on every non-root view — in the standalone PWA
 * there is no URL bar or back button to get home with. */
  home?: boolean;
  /** True while the menu panel is open — the menu button turns
   * into a ✕ and closes it (same button, two states). */
  menuOpen?: boolean;
  onMenu: () => void;
  /** When present (chat view), renders the voice-mode toggle. */
  voice?: {
    active: boolean;
    onToggle: () => void;
  };
  /** When present (chat view), renders the working-on star. */
  star?: {
    status: SessionStatus | undefined;
    folder: string;
    sessionId: string;
  };
  /** When present, renders the Web Push bell toggle. Push is
 * app-level (not per-session), so callers pass it on every view. */
  push?: {
    state: PushState;
    onToggle: () => void;
  };
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-800 px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className={
            "inline-block h-2 w-2 shrink-0 rounded-full " +
            (busy ? "bg-amber-400 animate-pulse" : "bg-neutral-700")
          }
        />
        {home ? (
          // The home affordance: a small house icon marks the
          // label as a link; the text stays what it was (the
          // folder path) so the header reads identically.
          <a
            href="/"
            aria-label="Back to folders"
            title="Back to folders"
            className="-ml-1 flex min-w-0 flex-1 items-center gap-1.5 rounded py-2 pl-1 pr-2 text-sm text-neutral-200 active:bg-neutral-900"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="shrink-0 text-neutral-600"
            >
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            <span className="min-w-0 truncate">{label}</span>
          </a>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
            {label}
          </span>
        )}
      </div>
      {star && (
        <StatusStar
          status={star.status}
          folder={star.folder}
          sessionId={star.sessionId}
        />
      )}
      {voice && (
        <button
          type="button"
          onClick={voice.onToggle}
          aria-pressed={voice.active}
          aria-label="Toggle voice conversation mode"
          title="Talk instead of typing — hands-free conversation"
          className={
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded active:bg-neutral-900 " +
            (voice.active ? "text-amber-300" : "text-neutral-600")
          }
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
            <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
            <line x1="12" y1="18" x2="12" y2="22" />
          </svg>
        </button>
      )}
      {push && (
        <button
          type="button"
          onClick={push.onToggle}
          aria-pressed={push.state === "on"}
          aria-label={
            push.state === "on"
              ? "Notifications enabled — click to disable"
              : "Enable push notifications on this device"
          }
          title={
            push.state === "on"
              ? "Notifications enabled — click to disable"
              : push.state === "denied"
                ? "Notifications blocked in browser settings"
                : "Get a push notification when a machine-seeded conversation lands"
          }
          className={
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded active:bg-neutral-900 " +
            (push.state === "on" ? "text-amber-300" : "text-neutral-600")
          }
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            {push.state !== "on" && <line x1="2" y1="2" x2="22" y2="22" />}
          </svg>
        </button>
      )}
      {/* Reload: the standalone PWA has no browser reload
          button, so this is the recovery path — re-fetches the
          document (and thus the loader data) from scratch. */}
      <button
        type="button"
        onClick={() => window.location.reload()}
        aria-label="Reload"
        title="Reload"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded text-neutral-500 active:bg-neutral-900"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onMenu}
        aria-expanded={menuOpen}
        aria-label={menuOpen ? "Close menu" : "Menu"}
        className="-mr-1 inline-flex h-9 w-9 items-center justify-center rounded text-neutral-500 active:bg-neutral-900"
      >
        {menuOpen ? (
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="5" y1="5" x2="19" y2="19" />
            <line x1="19" y1="5" x2="5" y2="19" />
          </svg>
        ) : (
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        )}
      </button>
    </header>
  );
}