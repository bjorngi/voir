import { useEffect, useState } from "react";
import type { ActivityRow, FolderSummary, ImageRef } from "~/lib/chat-types";
import { folderUrl, sessionUrl } from "~/lib/urls";
import { shortPath } from "~/lib/format";

/**
 * The share-target landing overlay (see share.server.ts for the
 * flow): an OS share (image/text from any Android app) staged
 * server-side, offered here with a pick of target chats.
 *
 * Rendered by ChatApp whenever `?shared=<id>` is in the URL
 * (the service worker lands there after staging). Rows:
 *
 *   Working on   live active sessions (the fast picks)
 *   per folder   the 3 most recent sessions, then
 *                "+ New chat in <folder>" (form POST intent=new
 *                with the shared id, so the fresh chat seeds on
 *                arrival)
 *
 * Folders whose agent never advertised promptCapabilities.image
 * get a "text only" pill when the share carries images — picking
 * them still works (the Composer seeds text; the image chips are
 * skipped rather than failing at send time).
 *
 * Closing strips the param: the staged share stays server-side
 * (re-share from the source app), nothing is lost.
 */

export function ShareSheet({
  id,
  activeRows,
  folders,
  onClose,
}: {
  id: string;
  activeRows: ActivityRow[];
  folders: FolderSummary[];
  onClose: () => void;
}) {
  const [manifest, setManifest] = useState<
    | { title?: string; text?: string; images: ImageRef[] }
    | null
  >(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/share/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        if (d && Array.isArray(d.images)) setManifest(d);
        else setFailed(true);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const hasImages = (manifest?.images?.length ?? 0) > 0;
  const suffix = `?shared=${encodeURIComponent(id)}`;

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-neutral-950">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-3">
        <span className="text-sm text-neutral-200">Send to…</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss share"
          className="h-8 w-8 text-neutral-400 active:text-neutral-200"
        >
          ✕
        </button>
      </div>

      {/* Preview */}
      <div className="shrink-0 border-b border-neutral-800 p-3">
        {failed && (
          <p className="text-sm text-rose-400">
            This share could not be found — share again from the source app.
          </p>
        )}
        {manifest && (
          <div className="flex flex-col gap-2">
            {manifest.text && (
              <p className="line-clamp-3 max-h-24 overflow-hidden text-sm text-neutral-300">
                {manifest.text}
              </p>
            )}
            {hasImages && (
              <div className="flex flex-wrap gap-1.5">
                {manifest.images.map((img) => (
                  <img
                    key={img.id}
                    src={`/api/uploads/${img.id}`}
                    alt={img.name ?? "Shared image"}
                    className="h-20 w-20 border border-neutral-700 object-cover"
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {!manifest && !failed && (
          <p className="text-sm text-neutral-500">Loading share…</p>
        )}
      </div>

      {/* Targets */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeRows.length > 0 && (
          <>
            <SectionLabel>Working on</SectionLabel>
            {activeRows.map((row) => (
              <a
                key={row.folder + row.sessionId}
                href={sessionUrl(row.folder, row.sessionId) + suffix}
                className="block px-4 py-3 text-sm text-neutral-200 active:bg-neutral-900"
              >
                <span className="mr-2 text-neutral-500">●</span>
                {row.title ?? row.sessionId.slice(0, 8)}
                <span className="ml-2 font-mono text-[11px] text-neutral-600">
                  {shortPath(row.folder)}
                </span>
              </a>
            ))}
          </>
        )}

        {folders.map((folder) => (
          <div key={folder.path}>
            <SectionLabel>
              {shortPath(folder.path)}
              {hasImages && !folder.image && (
                <span className="ml-2 rounded border border-neutral-800 px-1 py-0.5 font-mono text-[10px] normal-case tracking-normal text-neutral-600">
                  text only
                </span>
              )}
            </SectionLabel>
            {folder.sessions.slice(0, 3).map((s) => (
              <a
                key={s.id}
                href={sessionUrl(folder.path, s.id) + suffix}
                className="block truncate px-4 py-3 text-sm text-neutral-300 active:bg-neutral-900"
              >
                {s.title ?? s.id.slice(0, 8)}
              </a>
            ))}
            <NewChatRow folder={folder.path} sharedId={id} />
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 pb-1 pt-4 font-mono text-[10px] uppercase tracking-widest text-neutral-600">
      {children}
    </div>
  );
}

/** Same form as NewSessionAction, with the staged share id along
 *  so the redirect lands on a chat that seeds the share. */
function NewChatRow({ folder, sharedId }: { folder: string; sharedId: string }) {
  return (
    <form method="post" action={folderUrl(folder)}>
      <input type="hidden" name="intent" value="new" />
      <input type="hidden" name="shared" value={sharedId} />
      <button
        type="submit"
        className="block w-full px-4 py-3 text-left text-sm font-medium text-blue-400 active:bg-neutral-900"
      >
        + New chat
      </button>
    </form>
  );
}