/**
 * TopBar — the app's entire chrome, in one row.
 *
 * Why one row: on the fold's cover pane the viewport is 416×657, and
 * a 48px header plus a 40px tab strip spent 13% of it on chrome before
 * a single message rendered. On the inner pane (4:3, 609–816px wide)
 * the same two rows were also horizontally wasteful — three tabs
 * stretched across a slab. So the tabs move INTO the bar as a compact
 * segmented control, and the secondary actions (star, voice, push,
 * reload) fold into an overflow menu on narrow screens while staying
 * inline once there is room.
 *
 * Layout, left to right:
 *
 *   [☰]  context label (session title · folder)   [Chat|Files|Changes]  [⋯]
 *
 * Responsive behaviour, all CSS so SSR and client agree:
 *
 *   - bar height 48px, dropping to 40px under 560px of viewport
 *     height (the landscape panes) — the chrome yields to content;
 *   - tab labels appear from 480px wide (icon-only below: 3 × 36px
 *     instead of ~160px of text);
 *   - star / voice / push / reload inline from 768px (md), otherwise
 *     they live in the ⋯ menu — where they keep the same accessible
 *     names they had as standalone header buttons.
 *
 * The menu (☰) still opens the folder/session picker: navigation stays
 * a full-screen sheet on phones, which is the right affordance when a
 * tap target is a thumb.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SessionStatus } from "~/lib/chat-types";
import { postSessionStatus } from "~/lib/hooks";
import type { PushState } from "~/lib/use-push";
import { folderUrl, sessionUrl } from "~/lib/urls";

export interface ChangesBadge {
  files: number;
  additions: number;
  deletions: number;
}

/* ---------------------------------------------------------------------
 * Buttons
 * ------------------------------------------------------------------- */

function IconButton({
  label,
  title,
  onClick,
  children,
  active,
  expanded,
  className = "",
}: {
  label: string;
  title?: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  expanded?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title ?? label}
      {...(expanded === undefined ? {} : { "aria-expanded": expanded })}
      {...(active === undefined ? {} : { "aria-pressed": active })}
      className={
        "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded active:bg-neutral-900 " +
        (active ? "text-amber-300" : "text-neutral-500") +
        " " +
        className
      }
    >
      {children}
    </button>
  );
}

function StarButton({
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
  return (
    <IconButton
      label={active ? "Remove from Working on" : "Add to Working on"}
      title={
        active
          ? "Remove from Working on"
          : "Add to Working on — keeps it on the home shortlist"
      }
      active={active}
      onClick={() => {
        const next = active ? "none" : "active";
        setCurrent(next === "none" ? undefined : next);
        postSessionStatus(folder, sessionId, next);
      }}
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
    </IconButton>
  );
}

/* ---------------------------------------------------------------------
 * Tabs — a segmented control inside the bar
 * ------------------------------------------------------------------- */

const ICON_CHAT = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
  </svg>
);
const ICON_FILES = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);
const ICON_CHANGES = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <line x1="12" y1="3" x2="12" y2="15" />
    <polyline points="6 9 12 15 18 9" />
    <line x1="4" y1="21" x2="20" y2="21" />
  </svg>
);

function ViewTab({
  href,
  label,
  icon,
  active,
  badge,
}: {
  href: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  badge?: ChangesBadge;
}) {
  return (
    <a
      href={href}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={
        "inline-flex h-8 items-center gap-1.5 rounded px-2 text-[12px] transition-colors " +
        (active
          ? "bg-neutral-800 text-neutral-100"
          : "text-neutral-500 hover:text-neutral-300 active:bg-neutral-900")
      }
    >
      <span className="shrink-0">{icon}</span>
      {/* Labels from 480px: below that the icons carry the meaning and
          the width belongs to the context label. */}
      <span className="hidden [@media(min-width:480px)]:inline">{label}</span>
      {badge && badge.files > 0 && (
        <span className="ml-0.5 inline-flex items-center gap-1 font-mono text-[10px]">
          <span className="text-emerald-400">+{badge.additions}</span>
          <span className="text-rose-400">−{badge.deletions}</span>
        </span>
      )}
    </a>
  );
}

function ViewTabs({
  folder,
  activeSessionId,
  active,
  changesBadge,
}: {
  folder: string;
  activeSessionId: string | null;
  active: "chat" | "changes" | "files";
  changesBadge?: ChangesBadge;
}) {
  // Keep the session id in the tab URLs so switching tabs (and the
  // browser back button) returns to the same conversation.
  const base = activeSessionId
    ? sessionUrl(folder, activeSessionId)
    : folderUrl(folder);
  return (
    <nav
      aria-label="View"
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-neutral-800 bg-neutral-900/60 p-0.5"
    >
      <ViewTab href={base} label="Chat" icon={ICON_CHAT} active={active === "chat"} />
      <ViewTab
        href={`${base}?view=files`}
        label="Files"
        icon={ICON_FILES}
        active={active === "files"}
      />
      <ViewTab
        href={`${base}?view=changes`}
        label="Changes"
        icon={ICON_CHANGES}
        active={active === "changes"}
        badge={changesBadge}
      />
    </nav>
  );
}

/* ---------------------------------------------------------------------
 * Why a control is unavailable
 * ------------------------------------------------------------------- */

/** Both voice input and Web Push need a secure context. Over plain
 *  HTTP (the tailnet IP/name, which is how the app is opened on a
 *  phone without `tailscale serve`) the browser exposes neither
 *  `getUserMedia`-backed speech recognition nor `PushManager` — so
 *  say so instead of hiding the control. */
const HTTPS_HINT = "Needs HTTPS — open the app via `tailscale serve`";

function pushAvailability(state: PushState | undefined):
  | { ok: true }
  | { ok: false; reason: string } {
  if (!state) return { ok: false, reason: HTTPS_HINT };
  if (state === "unsupported") return { ok: false, reason: HTTPS_HINT };
  if (state === "denied")
    return { ok: false, reason: "Blocked in browser settings" };
  return { ok: true };
}

/* ---------------------------------------------------------------------
 * Overflow menu (narrow screens)
 * ------------------------------------------------------------------- */

function MenuItem({
  label,
  note,
  onClick,
  children,
  active,
  disabled,
}: {
  label: string;
  /** Second line: why it is unavailable, or a short state. */
  note?: string;
  onClick?: () => void;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-disabled={disabled || undefined}
      className={
        "flex w-full items-start gap-3 px-3 py-2.5 text-left text-[13px] " +
        (disabled
          ? "text-neutral-500"
          : active
            ? "text-amber-300 active:bg-neutral-900"
            : "text-neutral-300 active:bg-neutral-900")
      }
    >
      <span className="mt-0.5 shrink-0">{children}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {note && (
          <span className="mt-0.5 block font-mono text-[10px] leading-snug text-neutral-600">
            {note}
          </span>
        )}
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------------
 * TopBar
 * ------------------------------------------------------------------- */

export function TopBar({
  label,
  title,
  busy,
  conn,
  home,
  menuOpen,
  onMenu,
  onHide,
  voice,
  star,
  push,
  tabs,
}: {
  /** Context label: the folder's short path on list views, the
   *  session title in a conversation. */
  label: string;
  /** Secondary line of context (folder path) — wide screens only. */
  title?: string;
  busy?: boolean;
  /** Agent-stream state for the status dot. `undefined` on list views
   *  (no stream), "connecting" before the first connect, "lost" while
   *  reconnecting. */
  conn?: { state: "live" | "connecting" | "lost"; reason: string | null } | null;
  /** Render the label as a link back to "/". */
  home?: boolean;
  menuOpen?: boolean;
  onMenu: () => void;
  /** `enabled: false` renders the control anyway, marked unavailable —
   *  silence is the worst answer: the user goes looking for an icon
   *  that was never rendered and cannot tell whether the app is broken
   *  or the browser is. */
  voice?: { active: boolean; enabled: boolean; onToggle: () => void };
  star?: { status: SessionStatus | undefined; folder: string; sessionId: string };
  push?: { state: PushState; onToggle: () => void };
  /** Collapse the bar to nothing; the caller renders the restore
   *  affordance pinned to the top-right corner. */
  onHide?: () => void;
  /** When present, the view switcher renders inside the bar. */
  tabs?: {
    folder: string;
    activeSessionId: string | null;
    active: "chat" | "changes" | "files";
    changesBadge?: ChangesBadge;
  };
}) {
  const [overflow, setOverflow] = useState(false);
  // A one-line explanation under the bar when an unavailable control is
  // tapped (the control itself stays visible, so the answer is "needs
  // HTTPS", not "the app forgot my icon").
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => {
    if (!why) return;
    const t = setTimeout(() => setWhy(null), 4000);
    return () => clearTimeout(t);
  }, [why]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!overflow) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOverflow(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOverflow(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [overflow]);

  // Push availability is derived once: the icon always renders, but it
  // only acts when the browser can actually do push.
  const pushState = push ? { ...push, ...pushAvailability(push.state) } : undefined;

  const secondary = (
    <>
      {star && (
        <StarButton
          status={star.status}
          folder={star.folder}
          sessionId={star.sessionId}
        />
      )}
      {voice && (
        <IconButton
          label={
            voice.enabled
              ? "Toggle voice conversation mode"
              : `Voice conversation mode — ${HTTPS_HINT}`
          }
          title={
            voice.enabled
              ? "Talk instead of typing — hands-free conversation"
              : `Talk instead of typing — ${HTTPS_HINT}`
          }
          active={voice.active}
          onClick={() => {
            if (!voice.enabled) {
              setWhy(HTTPS_HINT);
              return;
            }
            voice.onToggle();
          }}
          className={voice.enabled ? "" : "opacity-40"}
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
        </IconButton>
      )}
      {pushState && (
        <IconButton
          label={
            pushState.state === "on"
              ? "Notifications enabled — click to disable"
              : pushState.ok
                ? "Enable push notifications on this device"
                : `Notifications — ${pushState.reason}`
          }
          title={
            pushState.state === "on"
              ? "Notifications enabled — click to disable"
              : pushState.ok
                ? "Get a push notification when a machine-seeded conversation lands"
                : pushState.reason
          }
          active={pushState.state === "on"}
          onClick={() => {
            if (!pushState.ok) {
              setWhy(pushState.reason);
              return;
            }
            pushState.onToggle();
          }}
          className={pushState.ok || pushState.state === "on" ? "" : "opacity-40"}
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
            {(pushState.state !== "on" || !pushState.ok) && (
              <line x1="2" y1="2" x2="22" y2="22" />
            )}
          </svg>
        </IconButton>
      )}
      <IconButton
        label="Reload"
        title="Reload — the PWA has no browser reload button"
        onClick={() => window.location.reload()}
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
      </IconButton>
    </>
  );

  // Height: 48px is generous for a phone that also has to show a
  // conversation. Every touch device gets 40px (measured: the fold pays
  // 48 in portrait otherwise), and below 560px of viewport height — the
  // landscape panes — it is 40 as well.
  return (
    <header className="relative flex h-12 shrink-0 items-center gap-1.5 border-b border-neutral-800 px-2 [@media(pointer:coarse)]:h-10 [@media(max-height:560px)]:h-10">
      {/* Navigation: the picker sheet. Stays on every width — it is also
          the folder switcher and session search. */}
      <IconButton
        label={menuOpen ? "Close menu" : "Menu"}
        title={menuOpen ? "Close menu" : "Folders, sessions, search"}
        expanded={menuOpen}
        onClick={onMenu}
        className="-ml-0.5"
      >
        {menuOpen ? (
          <svg
            width="18"
            height="18"
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
            width="18"
            height="18"
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
      </IconButton>

      {/* Context: status dot, title, and (wide screens) the folder path.
          The title itself is the way home — the PWA has no back button.
          Capped width so it never pushes the view switcher off; extra
          horizontal room belongs to the content, not the chrome. */}
      <div className="flex min-w-0 items-center gap-1.5">
        {/* One dot, one meaning: a running turn outranks everything
            (that is what the user is waiting on), then the stream
            state — sky while first connecting, amber while
            reconnecting. Idle-and-live is deliberately quiet. */}
        <span
          aria-hidden
          title={
            busy
              ? "Working"
              : conn?.state === "lost"
                ? `Connection lost${conn.reason ? ` — ${conn.reason}` : " — reconnecting"}`
                : conn?.state === "connecting"
                  ? "Connecting…"
                  : "Idle"
          }
          className={
            "inline-block h-1.5 w-1.5 shrink-0 rounded-full " +
            (busy
              ? "animate-pulse bg-amber-400"
              : conn?.state === "lost"
                ? "animate-pulse bg-amber-500"
                : conn?.state === "connecting"
                  ? "animate-pulse bg-sky-400"
                  : "bg-neutral-700")
          }
        />
        {home ? (
          <a
            href="/"
            aria-label="Back to folders"
            title="Back to folders"
            className="flex min-w-0 flex-1 items-baseline gap-2 rounded px-0.5 py-1 active:bg-neutral-900"
          >
            <span className="min-w-0 max-w-[14rem] truncate text-[13px] text-neutral-200 lg:max-w-[22rem]">
              {label}
            </span>
            {title && (
              <span className="hidden min-w-0 max-w-[16rem] truncate font-mono text-[11px] text-neutral-600 lg:inline">
                {title}
              </span>
            )}
          </a>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-200">
            {label}
          </span>
        )}
      </div>

      {tabs && (
        <div className="ml-1 shrink-0">
          <ViewTabs {...tabs} />
        </div>
      )}

      {/* Spacer: context+tabs stay together on the left, actions sit
          against the right edge where they are easy to hit. */}
      <div className="min-w-2 flex-1" />

      {/* Secondary actions: inline when there is room, otherwise the ⋯
          menu — same accessible names either way. */}
      <div className="hidden items-center md:flex">{secondary}</div>
      {/* Hide the whole bar; the caller renders the way back (a small
          button pinned to the top-right corner of the viewport). */}
      {onHide && (
        <IconButton
          label="Hide top bar"
          title="Hide top bar — more room for the conversation"
          onClick={onHide}
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
            <polyline points="6 15 12 9 18 15" />
          </svg>
        </IconButton>
      )}

      <div className="relative md:hidden" ref={box}>
        <IconButton
          label={overflow ? "Close actions" : "More actions"}
          title="More actions"
          expanded={overflow}
          onClick={() => setOverflow((v) => !v)}
          className="-mr-0.5"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <circle cx="5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="19" cy="12" r="1.7" />
          </svg>
        </IconButton>
        {overflow && (
          <div
            role="menu"
            className="absolute right-0 top-full z-40 mt-1 w-60 overflow-hidden rounded-md border border-neutral-800 bg-neutral-950 shadow-2xl"
          >
            {star && (
              <MenuItem
                label={
                  star.status === "active"
                    ? "Remove from Working on"
                    : "Add to Working on"
                }
                active={star.status === "active"}
                onClick={() => {
                  const next = star.status === "active" ? "none" : "active";
                  postSessionStatus(star.folder, star.sessionId, next);
                  setOverflow(false);
                }}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill={star.status === "active" ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </MenuItem>
            )}
            {voice && (
              <MenuItem
                label={
                  voice.enabled
                    ? "Voice conversation mode"
                    : "Voice conversation mode — unavailable"
                }
                note={voice.enabled ? undefined : HTTPS_HINT}
                disabled={!voice.enabled}
                active={voice.active}
                onClick={() => {
                  if (!voice.enabled) return;
                  voice.onToggle();
                  setOverflow(false);
                }}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                  <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
                </svg>
              </MenuItem>
            )}
            {pushState && (
              <MenuItem
                label={
                  pushState.state === "on"
                    ? "Notifications on"
                    : pushState.ok
                      ? "Enable notifications"
                      : "Notifications — unavailable"
                }
                note={pushState.ok ? undefined : pushState.reason}
                disabled={!pushState.ok && pushState.state !== "on"}
                active={pushState.state === "on"}
                onClick={() => {
                  if (!pushState.ok && pushState.state !== "on") return;
                  pushState.onToggle();
                  setOverflow(false);
                }}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
              </MenuItem>
            )}
            <MenuItem
              label="Reload"
              onClick={() => {
                setOverflow(false);
                window.location.reload();
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
              </svg>
            </MenuItem>
          </div>
        )}
      </div>
      {why && (
        <div
          role="status"
          className="absolute inset-x-2 top-full z-30 mt-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-[11px] leading-snug text-neutral-300 shadow-xl"
        >
          {why}
        </div>
      )}
    </header>
  );
}

/**
 * Restore handle for a hidden bar: pinned to the viewport's top-right
 * corner, small but a comfortable tap target (36×36 with a 44px hit
 * area via padding), translucent so it does not compete with content.
 */
export function ShowBarButton({
  onClick,
  busy,
}: {
  onClick: () => void;
  /** With the bar gone, the bar's status dot would be gone too — keep
   *  it here, so a hidden bar never hides the fact that a turn is
   *  running. */
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Show top bar"
      title="Show top bar"
      className="absolute right-0 top-0 z-30 m-1.5 inline-flex h-9 w-9 items-center justify-center rounded-md border border-neutral-700/70 bg-neutral-900/85 text-neutral-300 shadow-lg shadow-black/40 backdrop-blur-sm transition-colors hover:border-neutral-600 hover:text-white active:bg-neutral-800 before:absolute before:-inset-2 before:content-['']"
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
        <polyline points="6 9 12 15 18 9" />
      </svg>
      {busy && (
        <span
          aria-hidden
          className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400"
        />
      )}
    </button>
  );
}
