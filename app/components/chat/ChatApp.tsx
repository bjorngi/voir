/**
 * The app shell: header + (optional) tab bar + main view + picker overlay.
 * Renders one of four sub-views based on the loader data:
 * folders tree, sessions list, chat, or changes.
 */
import { useEffect, useState } from "react";
import type { ChatLoaderData } from "~/routes/chat";
import { folderUrl, sessionUrl } from "~/lib/urls";
import { shortPath } from "~/lib/format";
import { postSessionStatus, useSessionStatus } from "~/lib/hooks";
import type { ActivityRow, SessionStatus, SessionSummary } from "~/lib/chat-types";
import { useSpeechSynthesis } from "~/lib/use-tts";
import { usePush } from "~/lib/use-push";
import { WorkingOnSection } from "~/components/ActiveSessions";
import { FolderTree } from "~/components/FolderTree";
import { Picker } from "~/components/Picker";
import { SessionDebugButton } from "~/components/SessionDebugButton";
import { ChangesView } from "~/components/ChangesView";
import { FileExplorer } from "~/components/FileExplorer";
import { ChatView } from "./ChatView";
import { ChatTabs, type ChangesBadge } from "./ChatTabs";
import { Header } from "./Header";

export function ChatApp({ data }: { data: ChatLoaderData }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Voice conversation mode: the mode flag lives here (the Header
  // renders the toggle), the actual machine lives in ChatView.
  const [voiceActive, setVoiceActive] = useState(false);
  // Mic capability — post-mount like the tts/mic detection, so SSR
  // and hydration agree (the Voice button appears when capable).
  const [voiceSupported, setVoiceSupported] = useState(false);
  useEffect(() => {
    setVoiceSupported(
      !!navigator.mediaDevices?.getUserMedia &&
        typeof WebSocket !== "undefined",
    );
  }, []);
  // Spoken replies: voice mode narrates via the ChatView — the
  // engine (one hook instance) lives here, the speaking lives in
  // the chat view. The header shows no toggle; narration is a
  // voice-mode concern.
  const tts = useSpeechSynthesis();
  // Push notifications: app-level like tts. The bell shows on every
  // view once the probe settles (capable + VAPID configured).
  const push = usePush();
  // The "Working on" shortlist (docs/session-status.md): seeded
  // by the root loader so the dashboard's first paint is
  // server-rendered, then polled live. Both the root view and
  // the picker consume it — the picker is the fast-switch
  // surface, available from every view.
  const { rows: activeRows, unstar } = useSessionStatus(
    data.k === "folders" ? data.active : undefined,
  );

  // The tab bar lives between the header and the body for
  // chat, files and changes. Sessions-list and root views don't
  // have one — a tab bar on the root would be misleading (the
  // tabs are per-folder).
  const showTabs =
    data.k === "chat" || data.k === "changes" || data.k === "files";
  const label =
    data.k === "folders"
      ? "Folders"
      : shortPath(data.folder.path);
  const busy = data.k === "chat" ? data.session.busy : undefined;

  const changesBadge: ChangesBadge | undefined =
    data.k === "chat" || data.k === "files"
      ? data.folder.diffSummary
        ? {
            additions: data.folder.diffSummary.additions,
            deletions: data.folder.diffSummary.deletions,
            files: data.folder.diffSummary.files,
          }
        : undefined
      : data.k === "changes"
        ? data.diff.ok
          ? {
              additions: data.diff.summary.additions,
              deletions: data.diff.summary.deletions,
              files: data.diff.summary.files,
            }
          : undefined
        : undefined;

  return (
    <div className="flex h-full flex-col bg-neutral-950">
      <Header
        label={label}
        busy={busy}
        home={data.k !== "folders"}
        menuOpen={pickerOpen}
        onMenu={() => setPickerOpen((v) => !v)}
        star={
          data.k === "chat"
            ? {
                status: data.session.status,
                folder: data.folder.path,
                sessionId: data.session.id,
              }
            : undefined
        }
        voice={
          data.k === "chat" && voiceSupported
            ? {
                active: voiceActive,
                onToggle: () => setVoiceActive((v) => !v),
              }
            : undefined
        }
        push={
          push.state === "on" || push.state === "off" || push.state === "denied"
            ? {
                state: push.state,
                onToggle: push.toggle,
              }
            : undefined
        }
      />
      {showTabs && (
        <ChatTabs
          folder={data.folder.path}
          activeSessionId={
            data.k === "chat" ? data.session.id : data.fromSessionId
          }
          active={data.k === "chat" ? "chat" : data.k === "files" ? "files" : "changes"}
          changesBadge={changesBadge}
        />
      )}
      <main className="relative min-h-0 flex-1">
        {data.k === "folders" && (
          <FoldersView
            data={data}
            activeRows={activeRows}
            onUnstar={unstar}
            onPick={() => setPickerOpen(false)}
          />
        )}
        {data.k === "sessions" && (
          <SessionsView data={data} onPick={() => setPickerOpen(false)} />
        )}
        {data.k === "chat" && (
          <ChatView
            data={data}
            tts={tts}
            voiceActive={voiceActive}
            onVoiceActiveChange={setVoiceActive}
          />
        )}
        {data.k === "changes" && (
          <ChangesView
            folder={data.folder.path}
            diff={data.diff}
            snapshots={data.snapshots}
          />
        )}
        {data.k === "files" && <FileExplorer data={data} />}

        {pickerOpen && (
          <Picker active={activeRows} onClose={() => setPickerOpen(false)} />
        )}
      </main>
    </div>
  );
}

// -----------------------------------------------------------------------
// Sub-views
// -----------------------------------------------------------------------

function FoldersView({
  data,
  activeRows,
  onUnstar,
  onPick,
}: {
  data: Extract<ChatLoaderData, { k: "folders" }>;
  activeRows: ActivityRow[];
  onUnstar: (row: ActivityRow) => void;
  onPick: () => void;
}) {
  // The dashboard (docs/session-status.md): the curated
  // shortlist leads, the pile follows. Rows carry a ✕ (unstar,
  // the only manual cleanup act); the live state pill is the
  // "where is the ball" answer.
  return (
    <div className="h-full overflow-y-auto">
      <WorkingOnSection
        rows={activeRows}
        onUnstar={onUnstar}
        empty="Nothing active — star a chat to track it here, or start a new one."
      />
      <ul>
        {data.tree.map(({ folder, sessions }) => (
          <FolderTree
            key={folder.path}
            folder={folder}
            sessions={sessions}
            onPick={onPick}
          />
        ))}
      </ul>
    </div>
  );
}

function SessionsView({
  data,
  onPick,
}: {
  data: Extract<ChatLoaderData, { k: "sessions" }>;
  onPick: () => void;
}) {
  // Status overrides from the archive buttons: applied over the
  // loader data so toggles are instant (no reload); the POST
  // updates the store, and the next navigation re-stamps from
  // it. Same optimistic spirit as the star and the ✕.
  const [overrides, setOverrides] = useState<
    Record<string, SessionStatus | "none">
  >({});
  // "Show archived" is per-view ephemeral state (docs/
  // session-status.md): hidden must be the honest default on
  // every visit, so it is component state, not a query param.
  const [showArchived, setShowArchived] = useState(false);

  const statusOf = (s: SessionSummary): SessionStatus | undefined => {
    const o = overrides[s.id];
    if (o !== undefined) return o === "none" ? undefined : o;
    return s.status;
  };
  const archivedCount = data.sessions.filter(
    (s) => statusOf(s) === "archived",
  ).length;
  const rows = data.sessions
    .map((s) => ({ s, status: statusOf(s) }))
    .filter((r) => showArchived || r.status !== "archived");

  const toggleArchive = (s: SessionSummary) => {
    const next = statusOf(s) === "archived" ? "none" : "archived";
    setOverrides((o) => ({ ...o, [s.id]: next }));
    postSessionStatus(data.folder.path, s.id, next);
  };

  return (
    <ul className="h-full overflow-y-auto">
      <li>
        <NewSessionAction folder={data.folder.path} />
      </li>
      {archivedCount > 0 && (
        <li>
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="block w-full px-4 py-2 text-left text-xs text-neutral-500 active:bg-neutral-900"
          >
            {showArchived
              ? "Hide archived"
              : `Show archived (${archivedCount})`}
          </button>
        </li>
      )}
      {rows.map(({ s, status }) => (
        <li key={s.id} className="relative">
          <a
            href={sessionUrl(data.folder.path, s.id)}
            onClick={onPick}
            className={
              "block px-4 py-3 pr-20 text-sm active:bg-neutral-900 " +
              (status === "archived" ? "text-neutral-500" : "text-neutral-200")
            }
          >
            {status === "active" && (
              <span
                title="Active — in Working on"
                className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-blue-400 align-middle"
              />
            )}
            {status === "archived" && (
              <span className="mr-1.5 rounded border border-neutral-800 px-1 py-0.5 align-middle font-mono text-[10px] text-neutral-600">
                archived
              </span>
            )}
            {s.title ?? s.id.slice(0, 8)}
          </a>
          <SessionArchiveButton
            archived={status === "archived"}
            onToggle={() => toggleArchive(s)}
          />
          <SessionDebugButton session={s} folder={data.folder} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The archive/unarchive row action (docs/session-status.md):
 * putting a session away is a list-scanning act, so it lives
 * on the row, next to the SessionDebugButton it mirrors
 * (absolute overlay; the row reserves pr-20 for the two).
 */
function SessionArchiveButton({
  archived,
  onToggle,
}: {
  archived: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      aria-label={archived ? "Unarchive" : "Archive"}
      title={
        archived
          ? "Unarchive — back to the list"
          : "Archive — hide from lists"
      }
      className={
        "absolute right-9 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded active:bg-neutral-800 " +
        (archived ? "text-neutral-400" : "text-neutral-600")
      }
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
        <polyline points="21 8 21 21 3 21 3 8" />
        <rect x="1" y="3" width="22" height="5" rx="1" />
        <line x1="10" y1="12" x2="14" y2="12" />
      </svg>
    </button>
  );
}

function NewSessionAction({ folder }: { folder: string }) {
  return (
    <form method="post" action={folderUrl(folder)}>
      <input type="hidden" name="intent" value="new" />
      <button
        type="submit"
        className="block w-full px-4 py-3 text-left text-sm font-medium text-blue-400 active:bg-neutral-900"
      >
        + New chat
      </button>
    </form>
  );
}
