import { useState } from "react";
import type { FolderSummary, SessionSummary } from "~/lib/chat-types";
import { shortPath } from "~/lib/format";
import { folderUrl, sessionUrl } from "~/lib/urls";
import { SessionDebugButton } from "./SessionDebugButton";

/**
 * The picker is just a full-screen list. Tapping a folder expands it
 * to show its sessions. Tapping a session navigates to the chat.
 *
 * Single tap target, big rows, no nested UI. Tapping the backdrop
 * or pressing Escape closes it.
 *
 * The picker is for navigating between folders and sessions
 * only. The diff tab is reachable from the tab bar (when on
 * a chat or diff view) or from the `+N -M` pill on a folder
 * row in the root view — we deliberately don't surface it
 * here so the picker stays a focused folder/session navigator.
 */
export function Picker({
  data,
  onClose,
}: {
  data:
    | { k: "folders"; folders: FolderSummary[] }
    | { k: "sessions"; folders: FolderSummary[]; folder: FolderSummary; sessions: SessionSummary[] }
    | {
        k: "chat";
        folders: FolderSummary[];
        folder: FolderSummary;
        activeSessionId: string;
      }
    | {
        k: "changes";
        folders: FolderSummary[];
        folder: FolderSummary;
        activeSessionId: string | null;
      };
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(
    data.k === "sessions" || data.k === "chat" || data.k === "changes"
      ? data.folder.path
      : null,
  );

  const activeFolder =
    data.k === "folders" ? undefined : data.folder;
  const activeSessionId =
    data.k === "chat" || data.k === "changes"
      ? data.activeSessionId
      : undefined;
  const sessions =
    data.k === "sessions"
      ? data.sessions
      : data.k === "chat" || data.k === "changes"
        ? data.folder.sessions
        : [];

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-neutral-950">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 -z-10 bg-black/60"
      />
      <div className="flex h-full flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-3">
          <span className="text-sm text-neutral-200">Folders</span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center text-neutral-500 active:bg-neutral-900"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {data.folders.map((f) => {
            const isOpen = expanded === f.path;
            const isActive = activeFolder?.path === f.path;
            return (
              <div key={f.path}>
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : f.path)}
                  className={
                    "flex w-full items-center justify-between px-4 py-3 text-left text-sm active:bg-neutral-900 " +
                    (isActive ? "text-neutral-100" : "text-neutral-300")
                  }
                >
                  <span className="truncate font-mono">{shortPath(f.path)}</span>
                  <span className="text-xs text-neutral-600">{isOpen ? "−" : "+"}</span>
                </button>
                {isOpen && (
                  <ul className="bg-neutral-900/40 pb-2">
                    <li>
                      <a
                        href={folderUrl(f.path)}
                        onClick={onClose}
                        className="block px-8 py-2.5 text-sm text-blue-400 active:bg-neutral-800"
                      >
                        + New chat
                      </a>
                    </li>
                    {(isActive ? sessions : f.sessions).map((s) => (
                      <li key={s.id} className="relative">
                        <a
                          href={sessionUrl(f.path, s.id)}
                          onClick={onClose}
                          className={
                            "block px-8 py-2.5 pr-10 text-sm active:bg-neutral-800 " +
                            (activeSessionId === s.id
                              ? "text-neutral-100"
                              : "text-neutral-300")
                          }
                        >
                          {s.title ?? s.id.slice(0, 8)}
                        </a>
                        <SessionDebugButton session={s} folder={f} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

