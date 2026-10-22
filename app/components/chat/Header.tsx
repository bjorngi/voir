/**
 * The page header: a status dot + label, a text-to-speech toggle
 * (chat view only), and a menu button on the right that opens the
 * picker. The dot pulses amber while a turn is in flight;
 * otherwise it sits dim.
 */
export function Header({
  label,
  busy,
  onMenu,
  tts,
}: {
  label: string;
  busy?: boolean;
  onMenu: () => void;
  /** When present (chat view), renders the spoken-replies toggle. */
  tts?: {
    enabled: boolean;
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
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
          {label}
        </span>
      </div>
      {tts && (
        <button
          type="button"
          onClick={tts.onToggle}
          aria-pressed={tts.enabled}
          aria-label="Toggle spoken replies (text to speech)"
          title="Narrate agent replies out loud"
          className={
            "inline-flex h-9 shrink-0 items-center gap-1.5 rounded px-2 active:bg-neutral-900 " +
            (tts.enabled
              ? "text-amber-300"
              : "text-neutral-600")
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
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
          <span className="text-[11px] font-mono uppercase tracking-wider">
            Read aloud
          </span>
        </button>
      )}
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