/**
 * The app shell: header + (optional) tab bar + main view + picker overlay.
 * Renders one of four sub-views based on the loader data:
 * folders tree, sessions list, chat, or changes.
 */
import { useState } from "react";
import type { ChatLoaderData } from "~/routes/chat";
import { folderUrl, sessionUrl } from "~/lib/urls";
import { shortPath } from "~/lib/format";
import { useSpeechSynthesis } from "~/lib/use-tts";
import { FolderTree } from "~/components/FolderTree";
import { Picker } from "~/components/Picker";
import { SessionDebugButton } from "~/components/SessionDebugButton";
import { ChangesView } from "~/components/ChangesView";
import { ChatView } from "./ChatView";
import { ChatTabs, type ChangesBadge } from "./ChatTabs";
import { Header } from "./Header";

export function ChatApp({ data }: { data: ChatLoaderData }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Spoken replies: the toggle lives in the header, the speaking
  // lives in the chat view. One hook instance for both — the
  // state is per-app, not per-view.
  const tts = useSpeechSynthesis();

  // The tab bar lives between the header and the body for
  // chat and changes. Sessions-list and root views don't have
  // one — a tab bar on the root would be misleading (the tabs
  // are per-folder).
  const showTabs = data.k === "chat" || data.k === "changes";
  const label =
    data.k === "folders"
      ? "Folders"
      : shortPath(data.folder.path);
  const busy = data.k === "chat" ? data.session.busy : undefined;

  const changesBadge: ChangesBadge | undefined =
    data.k === "chat" || data.k === "changes"
      ? data.k === "chat"
        ? data.folder.diffSummary
          ? {
              additions: data.folder.diffSummary.additions,
              deletions: data.folder.diffSummary.deletions,
              files: data.folder.diffSummary.files,
            }
          : undefined
        : data.diff.ok
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
        onMenu={() => setPickerOpen(true)}
        tts={
          data.k === "chat" && tts.supported
            ? {
                enabled: tts.enabled,
                onToggle: () => tts.setEnabled(!tts.enabled),
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
          active={data.k === "chat" ? "chat" : "changes"}
          changesBadge={changesBadge}
        />
      )}
      <main className="relative min-h-0 flex-1">
        {data.k === "folders" && (
          <FoldersView data={data} onPick={() => setPickerOpen(false)} />
        )}
        {data.k === "sessions" && (
          <SessionsView data={data} onPick={() => setPickerOpen(false)} />
        )}
        {data.k === "chat" && <ChatView data={data} tts={tts} />}
        {data.k === "changes" && (
          <ChangesView
            folder={data.folder.path}
            diff={data.diff}
            snapshots={data.snapshots}
          />
        )}

        {pickerOpen && (
          <Picker
            onClose={() => setPickerOpen(false)}
            data={
              data.k === "folders"
                ? { k: "folders", folders: data.folders }
                : data.k === "sessions"
                  ? {
                      k: "sessions",
                      folders: data.folders,
                      folder: data.folder,
                      sessions: data.sessions,
                    }
                  : data.k === "chat"
                    ? {
                        k: "chat",
                        folders: data.folders,
                        folder: data.folder,
                        activeSessionId: data.session.id,
                      }
                    : {
                        k: "changes",
                        folders: data.folders,
                        folder: data.folder,
                        activeSessionId: data.fromSessionId,
                      }
            }
          />
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
  onPick,
}: {
  data: Extract<ChatLoaderData, { k: "folders" }>;
  onPick: () => void;
}) {
  return (
    <ul className="h-full overflow-y-auto">
      {data.tree.map(({ folder, sessions }) => (
        <FolderTree
          key={folder.path}
          folder={folder}
          sessions={sessions}
          onPick={onPick}
        />
      ))}
    </ul>
  );
}

function SessionsView({
  data,
  onPick,
}: {
  data: Extract<ChatLoaderData, { k: "sessions" }>;
  onPick: () => void;
}) {
  return (
    <ul className="h-full overflow-y-auto">
      <li>
        <NewSessionAction folder={data.folder.path} />
      </li>
      {data.sessions.map((s) => (
        <li key={s.id} className="relative">
          <a
            href={sessionUrl(data.folder.path, s.id)}
            onClick={onPick}
            className="block px-4 py-3 pr-10 text-sm text-neutral-200 active:bg-neutral-900"
          >
            {s.title ?? s.id.slice(0, 8)}
          </a>
          <SessionDebugButton session={s} folder={data.folder} />
        </li>
      ))}
    </ul>
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
