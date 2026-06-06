import { useState, useRef } from "react";
import type { FolderSummary, SessionSummary } from "~/lib/chat-types";
import { useDebugPopoverDismiss } from "./DebugPopover";

/**
 * "···" button overlaid on a session list row. Clicking opens a
 * popover with the session's raw data and a copy button, mirroring
 * the debug panel used on chat messages (see Message.tsx).
 *
 * The button stops propagation so the surrounding row (which is a
 * navigation link) does not fire when the user is just inspecting
 * debug info.
 */
export function SessionDebugButton({
  session,
  folder,
}: {
  session: SessionSummary;
  folder: FolderSummary;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDebugPopoverDismiss(ref, open, setOpen);

  // Curate the folder payload: full FolderSummary recursively contains
  // every session, which is wasteful and would explode in the popover.
  // Pick the fields that are actually useful for inspecting a session.
  const json = JSON.stringify(
    {
      session,
      folder: {
        path: folder.path,
        agentName: folder.agentName,
        agentUrl: folder.agentUrl,
        registeredAt: folder.registeredAt,
      },
    },
    null,
    2,
  );

  return (
    <div ref={ref} className="absolute right-2 top-1/2 -translate-y-1/2 z-10">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="inline-flex h-6 w-6 items-center justify-center font-mono text-[14px] leading-none text-neutral-600 active:bg-neutral-800 active:text-neutral-300"
        aria-label="Debug"
        title="Debug"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-20 w-[min(90vw,28rem)] max-h-[70vh] overflow-auto border border-neutral-700 bg-neutral-950 p-3 text-[11px] shadow-2xl">
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-neutral-800 pb-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">
              Debug
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                navigator.clipboard?.writeText(json);
              }}
              className="font-mono text-[10px] uppercase tracking-widest text-neutral-500 active:text-neutral-200"
            >
              Copy
            </button>
          </div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-neutral-400">
            <dt className="text-neutral-600">id</dt>
            <dd className="break-all text-neutral-200">{session.id}</dd>
            <dt className="text-neutral-600">title</dt>
            <dd>
              {session.title ?? (
                <span className="text-neutral-600">—</span>
              )}
            </dd>
            <dt className="text-neutral-600">createdAt</dt>
            <dd className="text-neutral-500">
              {new Date(session.createdAt).toISOString()} ({session.createdAt})
            </dd>
            <dt className="text-neutral-600">messageCount</dt>
            <dd>{session.messageCount}</dd>
            <dt className="text-neutral-600">folder</dt>
            <dd className="break-all text-neutral-300">{folder.path}</dd>
            {folder.agentName && (
              <>
                <dt className="text-neutral-600">agent</dt>
                <dd>{folder.agentName}</dd>
              </>
            )}
            <dt className="text-neutral-600">agentUrl</dt>
            <dd className="break-all text-neutral-500">{folder.agentUrl}</dd>
            <dt className="text-neutral-600">registeredAt</dt>
            <dd className="text-neutral-500">
              {new Date(folder.registeredAt).toISOString()} ({folder.registeredAt})
            </dd>
          </dl>
          <pre className="mt-3 overflow-auto border-t border-neutral-800 pt-2 font-mono text-[11px] leading-relaxed text-neutral-300">
            {json}
          </pre>
        </div>
      )}
    </div>
  );
}
