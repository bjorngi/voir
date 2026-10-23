import { useState } from "react";
import type { FolderSummary, SessionSummary } from "~/lib/chat-types";
import { shortPath } from "~/lib/format";
import { folderUrl, sessionUrl } from "~/lib/urls";
import { SessionDebugButton } from "./SessionDebugButton";

/**
 * A folder row on the root / view, with its sessions indented
 * underneath — a small file structure. Tapping the folder name
 * navigates to /f/<path> (which is the dedicated sessions view for
 * that folder). Tapping the chevron collapses the tree locally
 * without navigating. Tapping a session opens the chat.
 *
 * Each session row carries a SessionDebugButton so the per-session
 * debug popover is available here just like in the picker.
 *
 * A `+N -M` pill on the right of the folder row summarises
 * the worktree's diff vs the auto-detected base branch AND
 * doubles as a tap target for the diff tab. Tapping the pill
 * jumps straight to /f/<path>?view=diff — a one-tap shortcut
 * for users who want to see what's changed before opening a
 * chat. The pill is only rendered when the folder is a git
 * repo with a detectable base; non-git folders get no pill.
 */
export function FolderTree({
  folder,
  sessions,
  onPick,
}: {
  folder: FolderSummary;
  sessions: SessionSummary[];
  onPick?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const href = folderUrl(folder.path);
  const diffHref = `${href}?view=diff`;
  return (
    <li>
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Collapse" : "Expand"}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center text-xs text-neutral-600 active:bg-neutral-900"
        >
          {open ? "−" : "+"}
        </button>
        <a
          href={href}
          onClick={onPick}
          className="block flex-1 truncate py-3 pr-2 text-sm text-neutral-200 active:bg-neutral-900"
        >
          <span className="font-mono">{shortPath(folder.path)}</span>
        </a>
        {folder.agentName && (
          <span
            title={`Agent${folder.agentName.includes(" · ") ? "s" : ""}: ${folder.agentName}`}
            className="mr-2 shrink-0 select-none rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400"
          >
            {folder.agentName}
          </span>
        )}
        {folder.status === "degraded" && (
          <span
            title={`Agent offline — last seen ${new Date(folder.lastSeenAt).toLocaleTimeString()}`}
            className="mr-2 shrink-0 select-none font-mono text-[11px] text-amber-500"
          >
            offline
          </span>
        )}
        {folder.diffSummary && (
          <a
            href={diffHref}
            onClick={onPick}
            aria-label={`View diff: +${folder.diffSummary.additions} -${folder.diffSummary.deletions} across ${folder.diffSummary.files} files vs ${folder.diffSummary.base}`}
            className="mr-3 shrink-0 select-none rounded border border-neutral-800 px-2 py-0.5 font-mono text-[11px] tabular-nums active:bg-neutral-900"
          >
            <span className="text-emerald-400">+{folder.diffSummary.additions}</span>
            {" "}
            <span className="text-rose-400">−{folder.diffSummary.deletions}</span>
            <span className="ml-1.5 text-neutral-500">{folder.diffSummary.files}</span>
          </a>
        )}
      </div>
      {open && (
        <ul className="bg-neutral-900/40 pb-2">
          <li className="relative">
            <form method="post" action={href}>
              <input type="hidden" name="intent" value="new" />
              <button
                type="submit"
                className="block w-full px-12 py-2 text-left text-sm font-medium text-blue-400 active:bg-neutral-800"
              >
                + New chat
              </button>
            </form>
          </li>
          {sessions
            // Archived sessions are hidden from every list by
            // default (docs/session-status.md); the sessions
            // view's "Show archived" toggle is the only reveal.
            .filter((s) => s.status !== "archived")
            .map((s) => (
              <li key={s.id} className="relative">
                <a
                  href={sessionUrl(folder.path, s.id)}
                  onClick={onPick}
                  className="block px-12 py-2 pr-10 text-sm text-neutral-300 active:bg-neutral-800"
                >
                  {s.status === "active" && (
                    <span
                      title="Active — in Working on"
                      className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-blue-400 align-middle"
                    />
                  )}
                  {s.title ?? s.id.slice(0, 8)}
                </a>
                <SessionDebugButton session={s} folder={folder} />
              </li>
            ))}
        </ul>
      )}
    </li>
  );
}
