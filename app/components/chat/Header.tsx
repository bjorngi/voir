/**
 * The page header: a status dot + label, with a menu button on
 * the right that opens the picker. The dot pulses amber while
 * a turn is in flight; otherwise it sits dim.
 */
export function Header({
  label,
  busy,
  onMenu,
}: {
  label: string;
  busy?: boolean;
  onMenu: () => void;
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
