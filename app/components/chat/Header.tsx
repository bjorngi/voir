/**
 * The page header: a status dot + label, and the view toggles
 * on the right (voice-mode mic, push bell) that end in the
 * reload and menu buttons. The dot pulses amber while a turn
 * is in flight; otherwise it sits dim.
 *
 * Installed-PWA affordances (there is no browser chrome to lean
 * on in standalone): a reload button, and — when `home` is set —
 * the label itself becomes a link back to the root folders
 * view.
 */
import type { PushState } from "~/lib/use-push";

export function Header({
  label,
  busy,
  home,
  onMenu,
  voice,
  push,
}: {
  label: string;
  busy?: boolean;
  /** When true, the label is rendered as a link back to "/".
 * Pass it on every non-root view — in the standalone PWA
 * there is no URL bar or back button to get home with. */
  home?: boolean;
  onMenu: () => void;
  /** When present (chat view), renders the voice-mode toggle. */
  voice?: {
    active: boolean;
    onToggle: () => void;
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
        className="-mr-1 inline-flex h-9 w-9 items-center justify-center rounded text-neutral-500 active:bg-neutral-900"
        aria-label="Menu"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
    </header>
  );
}