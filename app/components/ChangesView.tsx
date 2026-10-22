import { useEffect, useMemo, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import type { DiffFile } from "~/lib/chat-types";
import type { SnapshotSummary } from "~/lib/timeline.server";
import { DiffBody } from "~/components/DiffView";

/**
 * Combined changes view.
 *
 * Renders a single tree that interleaves real git commits with the
 * turn-by-turn snapshots captured automatically at the end of each
 * agent turn. The newest state is at the top:
 *
 *   Uncommitted          ← current worktree diff + snapshots since last commit
 *     └── snap #3
 *     └── snap #2
 *   Commit abc1234       ← last real git commit
 *     └── snap #1        ← snapshots that led to this commit
 *   Commit def5678
 *     └── …
 *
 * Each snapshot card can expand to show its turn delta, and can be
 * restored (with an automatic pre-restore backup). The header has
 * Commit and Push actions.
 */
export function ChangesView({
  folder,
  diff,
  snapshots,
}: {
  folder: string;
  diff: DiffPayload;
  snapshots: SnapshotSummary[];
}) {
  const { revalidate } = useRevalidator();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Map<string, DiffPayload>>(new Map());
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<{
    snapshotId: string;
    backupId: string;
  } | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<string | null>(null);

  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  useMemo(() => {
    fetch(`/api/commits?folder=${encodeURIComponent(folder)}`)
      .then((r) => r.json())
      .then((data) => setCommits((data as { commits?: CommitInfo[] }).commits ?? []))
      .catch(() => setCommits([]));
  }, [folder]);

  async function expandSnapshot(id: string, prevId?: string) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (diffs.has(id)) return;
    const result = await fetchTimelineDiff(folder, prevId, id);
    setDiffs((prev) => {
      const next = new Map(prev);
      next.set(id, result);
      return next;
    });
  }

  async function restore(id: string) {
    if (
      !confirm(
        "Restore the worktree to this snapshot? Current state will be backed up first.",
      )
    ) {
      return;
    }
    setRestoring(id);
    setRestoreNotice(null);
    try {
      const res = await fetch("/api/timeline-restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder, snapshotId: id }),
      });
      if (res.ok) {
        const data = (await res.json()) as { backup: { id: string } };
        setRestoreNotice({ snapshotId: id, backupId: data.backup.id });
        revalidate();
      } else {
        const err = (await res.json()) as { error?: string };
        alert(err.error ?? "Restore failed");
      }
    } finally {
      setRestoring(null);
    }
  }

  async function commit() {
    const message = commitMessage.trim();
    if (!message) return;
    setCommitting(true);
    setCommitResult(null);
    try {
      const res = await fetch("/api/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder, message }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (data.ok) {
        setCommitResult("Committed.");
        setCommitMessage("");
        revalidate();
      } else {
        setCommitResult(data.error ?? "Commit failed.");
      }
    } finally {
      setCommitting(false);
    }
  }

  async function push() {
    setPushing(true);
    setPushResult(null);
    try {
      const res = await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      setPushResult(data.ok ? "Pushed." : data.error ?? "Push failed.");
    } finally {
      setPushing(false);
    }
  }

  const hasUncommittedDiff =
    diff.ok &&
    (diff.files.length > 0 ||
      diff.summary.additions > 0 ||
      diff.summary.deletions > 0 ||
      diff.summary.untracked > 0);

  const tree = useMemo(() => {
    if (commits === null) return null;
    const sortedCommits = commits.slice().sort((a, b) => b.date - a.date);
    const sortedSnapshots = snapshots.slice().sort((a, b) => b.at - a.at);

    const uncommitted: TreeNode = { kind: "uncommitted", snapshots: [] };
    const commitNodes = sortedCommits.map((c) => ({
      kind: "commit" as const,
      commit: c,
      snapshots: [] as SnapshotSummary[],
    }));

    for (const snap of sortedSnapshots) {
      // Find the newest commit whose date is >= the snapshot date.
      // That commit "contains" this snapshot's work.
      const owningCommit = commitNodes.find((n) => n.commit.date * 1000 >= snap.at);
      if (owningCommit) {
        owningCommit.snapshots.push(snap);
      } else {
        uncommitted.snapshots.push(snap);
      }
    }

    const out: TreeNode[] = [];
    if (uncommitted.snapshots.length > 0 || hasUncommittedDiff) {
      out.push(uncommitted);
    }
    out.push(...commitNodes);
    return out;
  }, [commits, snapshots, hasUncommittedDiff]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChangesHeader
        diff={diff}
        commitMessage={commitMessage}
        onCommitMessageChange={setCommitMessage}
        committing={committing}
        onCommit={commit}
        commitResult={commitResult}
        pushing={pushing}
        onPush={push}
        pushResult={pushResult}
      />

      <div className="flex-1 overflow-y-auto">
        {restoreNotice && (
          <RestoreNotice
            snapshotId={restoreNotice.snapshotId}
            backupId={restoreNotice.backupId}
            onDismiss={() => setRestoreNotice(null)}
          />
        )}

        {diff.ok ? (
          tree === null ? (
            <div className="px-3 py-4 text-center font-mono text-[11px] text-neutral-500">
              Loading history…
            </div>
          ) : tree.length === 0 ? (
            <div className="px-3 py-6 text-center">
              <div className="font-mono text-[12px] uppercase tracking-widest text-neutral-500">
                No changes
              </div>
              <div className="mt-1 text-sm text-neutral-400">
                No uncommitted work and no commit history yet.
              </div>
            </div>
          ) : (
            <HistoryTree
              folder={folder}
              diff={diff}
              tree={tree}
              hasUncommittedDiff={hasUncommittedDiff}
              expandedId={expandedId}
              diffs={diffs}
              restoring={restoring}
              onExpand={expandSnapshot}
              onRestore={restore}
            />
          )
        ) : (
          <div className="px-3 py-6 text-center">
            <div className="font-mono text-[12px] uppercase tracking-widest text-neutral-500">
              {diff.reason === "not-repo"
                ? "Not a git repository"
                : diff.reason === "no-base"
                  ? "No base branch"
                  : "Diff unavailable"}
            </div>
            <div className="mt-1 text-sm text-neutral-400">{diff.message}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Header with commit / push
// -----------------------------------------------------------------------

function ChangesHeader({
  diff,
  commitMessage,
  onCommitMessageChange,
  committing,
  onCommit,
  commitResult,
  pushing,
  onPush,
  pushResult,
}: {
  diff: DiffPayload;
  commitMessage: string;
  onCommitMessageChange: (v: string) => void;
  committing: boolean;
  onCommit: () => void;
  commitResult: string | null;
  pushing: boolean;
  onPush: () => void;
  pushResult: string | null;
}) {
  const stats =
    diff.ok ? diff.summary : { files: 0, additions: 0, deletions: 0, untracked: 0 };
  const canCommit = diff.ok && stats.files > 0;

  return (
    <div className="shrink-0 border-b border-neutral-800 px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-mono text-[12px] text-neutral-300">
          {diff.ok ? (
            <>
              <span className="text-emerald-400">+{stats.additions}</span>{" "}
              <span className="text-rose-400">−{stats.deletions}</span>
              <span className="ml-2 text-neutral-500">
                {stats.files === 1 ? "1 file" : `${stats.files} files`}
              </span>
              {stats.untracked > 0 && (
                <span className="ml-2 text-neutral-600">
                  ({stats.untracked} untracked)
                </span>
              )}
            </>
          ) : (
            <span className="text-neutral-500">No stats</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onPush}
            disabled={pushing}
            className="rounded border border-neutral-800 px-2.5 py-1 font-mono text-[11px] text-neutral-400 active:bg-neutral-900 disabled:opacity-50"
          >
            {pushing ? "Pushing…" : "Push"}
          </button>
        </div>
      </div>
      {pushResult && (
        <div
          className={
            "mb-2 font-mono text-[11px] " +
            (pushResult === "Pushed." ? "text-emerald-400" : "text-rose-400")
          }
        >
          {pushResult}
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={commitMessage}
          onChange={(e) => onCommitMessageChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canCommit && !committing) onCommit();
          }}
          placeholder="Commit message…"
          disabled={committing}
          className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
        />
        <button
          type="button"
          onClick={onCommit}
          disabled={!canCommit || committing}
          className="rounded border border-emerald-900/60 px-3 py-1.5 font-mono text-[11px] text-emerald-400 active:bg-emerald-950/30 disabled:opacity-50"
        >
          {committing ? "Committing…" : "Commit"}
        </button>
      </div>
      {commitResult && (
        <div
          className={
            "mt-1.5 font-mono text-[11px] " +
            (commitResult === "Committed." ? "text-emerald-400" : "text-rose-400")
          }
        >
          {commitResult}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------
// History tree: commits + snapshots
// -----------------------------------------------------------------------

type TreeNode =
  | { kind: "uncommitted"; snapshots: SnapshotSummary[] }
  | { kind: "commit"; commit: CommitInfo; snapshots: SnapshotSummary[] };

function HistoryTree({
  folder,
  diff,
  tree,
  hasUncommittedDiff,
  expandedId,
  diffs,
  restoring,
  onExpand,
  onRestore,
}: {
  folder: string;
  diff: Extract<DiffPayload, { ok: true }>;
  tree: TreeNode[];
  hasUncommittedDiff: boolean;
  expandedId: string | null;
  diffs: Map<string, DiffPayload>;
  restoring: string | null;
  onExpand: (id: string, prevId?: string) => void;
  onRestore: (id: string) => void;
}) {
  // All snapshots in the tree, in global newest-first order, so
  // each card can reference the next older snapshot as its prevId.
  const allSnapshots = useMemo(() => {
    const out: SnapshotSummary[] = [];
    for (const node of tree) out.push(...node.snapshots);
    return out.sort((a, b) => b.at - a.at);
  }, [tree]);

  return (
    <div>
      {tree.map((node, nodeIndex) => {
        if (node.kind === "uncommitted") {
          return (
            <UncommittedNode
              folder={folder}
              key="uncommitted"
              diff={diff}
              hasDiff={hasUncommittedDiff}
              snapshots={node.snapshots}
              allSnapshots={allSnapshots}
              expandedId={expandedId}
              diffs={diffs}
              restoring={restoring}
              onExpand={onExpand}
              onRestore={onRestore}
            />
          );
        }
        return (
          <CommitNode
            key={node.commit.sha}
            folder={folder}
            commit={node.commit}
            snapshots={node.snapshots}
            allSnapshots={allSnapshots}
            expandedId={expandedId}
            diffs={diffs}
            restoring={restoring}
            onExpand={onExpand}
            onRestore={onRestore}
          />
        );
      })}
    </div>
  );
}

function UncommittedNode({
  folder,
  diff,
  hasDiff,
  snapshots,
  allSnapshots,
  expandedId,
  diffs,
  restoring,
  onExpand,
  onRestore,
}: {
  folder: string;
  diff: Extract<DiffPayload, { ok: true }>;
  hasDiff: boolean;
  snapshots: SnapshotSummary[];
  allSnapshots: SnapshotSummary[];
  expandedId: string | null;
  diffs: Map<string, DiffPayload>;
  restoring: string | null;
  onExpand: (id: string, prevId?: string) => void;
  onRestore: (id: string) => void;
}) {
  return (
    <div className="border-b border-neutral-800">
      <div className="flex items-center gap-2 bg-neutral-900/40 px-3 py-2">
        <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
        <span className="font-mono text-[12px] font-medium text-neutral-200">
          Uncommitted
        </span>
        {hasDiff && (
          <span className="font-mono text-[11px] text-neutral-500">
            +{diff.summary.additions} / −{diff.summary.deletions}
          </span>
        )}
      </div>

      {hasDiff && (
        <div className="px-1 pb-2">
          <CurrentDiffFiles files={diff.files} />
        </div>
      )}

      <SnapshotList
        folder={folder}
        snapshots={snapshots}
        allSnapshots={allSnapshots}
        expandedId={expandedId}
        diffs={diffs}
        restoring={restoring}
        onExpand={onExpand}
        onRestore={onRestore}
      />
    </div>
  );
}

function CommitNode({
  folder,
  commit,
  snapshots,
  allSnapshots,
  expandedId,
  diffs,
  restoring,
  onExpand,
  onRestore,
}: {
  folder: string;
  commit: CommitInfo;
  snapshots: SnapshotSummary[];
  allSnapshots: SnapshotSummary[];
  expandedId: string | null;
  diffs: Map<string, DiffPayload>;
  restoring: string | null;
  onExpand: (id: string, prevId?: string) => void;
  onRestore: (id: string) => void;
}) {
  return (
    <div className="border-b border-neutral-800">
      <div className="flex items-center gap-2 bg-neutral-900/40 px-3 py-2">
        <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
        <span className="min-w-0 flex-1 font-mono text-[12px] font-medium text-neutral-200">
          <span className="text-neutral-500">{commit.sha.slice(0, 7)}</span>{" "}
          {commit.message}
        </span>
      </div>
      <div className="px-3 py-1 font-mono text-[11px] text-neutral-600">
        {formatTime(commit.date * 1000)} · {commit.author}
      </div>

      <SnapshotList
        folder={folder}
        snapshots={snapshots}
        allSnapshots={allSnapshots}
        expandedId={expandedId}
        diffs={diffs}
        restoring={restoring}
        onExpand={onExpand}
        onRestore={onRestore}
      />
    </div>
  );
}

function SnapshotList({
  folder,
  snapshots,
  allSnapshots,
  expandedId,
  diffs,
  restoring,
  onExpand,
  onRestore,
}: {
  folder: string;
  snapshots: SnapshotSummary[];
  allSnapshots: SnapshotSummary[];
  expandedId: string | null;
  diffs: Map<string, DiffPayload>;
  restoring: string | null;
  onExpand: (id: string, prevId?: string) => void;
  onRestore: (id: string) => void;
}) {
  return (
    <div className="pl-3">
      {snapshots.map((s) => {
        const globalIndex = allSnapshots.findIndex((x) => x.id === s.id);
        const prevId =
          globalIndex >= 0 && globalIndex < allSnapshots.length - 1
            ? allSnapshots[globalIndex + 1].id
            : undefined;
        return (
          <SnapshotCard
            folder={folder}
            key={s.id}
            snapshot={s}
            prevId={prevId}
            expanded={expandedId === s.id}
            diff={diffs.get(s.id)}
            restoring={restoring === s.id}
            onExpand={() => onExpand(s.id, prevId)}
            onRestore={() => onRestore(s.id)}
          />
        );
      })}
    </div>
  );
}

/**
 * The "Uncommitted" section's file cards — every changed file,
 * each with a GitHub-PR-style **viewed** check: marking a file
 * viewed collapses it to its header (done reviewing); unchecking
 * brings the body back. The set lives here and resets on reload,
 * like GitHub resets "viewed" when new commits land.
 */
function CurrentDiffFiles({ files }: { files: DiffFile[] }) {
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  const toggleViewed = (path: string) =>
    setViewed((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <div className="space-y-2">
      {files.map((f) => {
        const isViewed = viewed.has(f.path);
        return (
          <div
            key={f.path}
            className={
              "rounded bg-neutral-950 " +
              (isViewed ? "border border-neutral-900" : "border border-neutral-800")
            }
          >
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-2 py-1 font-mono text-[11px]">
              <span className="text-emerald-400">+{f.additions}</span>
              <span className="text-rose-400">−{f.deletions}</span>
              <span
                className={
                  "min-w-0 flex-1 truncate " +
                  (isViewed ? "text-neutral-500" : "text-neutral-300")
                }
              >
                {f.path}
              </span>
              <ViewedCheck viewed={isViewed} onToggle={() => toggleViewed(f.path)} />
            </div>
            {!isViewed && <DiffBody file={f} bordered={false} maxHeight={false} />}
          </div>
        );
      })}
    </div>
  );
}

function ViewedCheck({
  viewed,
  onToggle,
}: {
  viewed: boolean;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  // After the collapse/expand commits, keep the tapped button in
  // view — with 31 cards, closing one pulls the next file's diff
  // up under your thumb, and you want to see which file you just
  // closed. "nearest" = minimal movement; "instant" = no
  // animation. (Skipped on mount — no scroll on page load.)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    ref.current?.scrollIntoView({
      block: "nearest",
      behavior: "instant" as ScrollBehavior,
    });
  }, [viewed]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-pressed={viewed}
      title={viewed ? "Mark as not viewed" : "Mark as viewed (collapses the file)"}
      className={
        "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest " +
        (viewed
          ? "bg-neutral-900 text-emerald-400"
          : "border border-neutral-800 text-neutral-600 active:text-neutral-300")
      }
    >
      {/* square check, filled when viewed */}
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
      viewed
    </button>
  );
}

// -----------------------------------------------------------------------
// Snapshot cards
// -----------------------------------------------------------------------

function SnapshotCard({
  folder,
  snapshot,
  prevId,
  expanded,
  diff,
  restoring,
  onExpand,
  onRestore,
}: {
  folder: string;
  snapshot: SnapshotSummary;
  prevId?: string;
  expanded: boolean;
  diff?: DiffPayload;
  restoring: boolean;
  onExpand: () => void;
  onRestore: () => void;
}) {
  const time = useMemo(() => formatTime(snapshot.at), [snapshot.at]);
  const additions = snapshot.additions ?? 0;
  const deletions = snapshot.deletions ?? 0;

  return (
    <div className="border-l border-neutral-800 pl-4">
      <button
        type="button"
        onClick={onExpand}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 py-2.5 text-left active:text-neutral-100"
      >
        <span className="font-mono text-[11px] text-neutral-500">#{snapshot.turn}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-neutral-300">
            {snapshot.prompt ?? (
              <span className="italic text-neutral-500">
                {snapshot.reason === "before-restore"
                  ? "Pre-restore backup"
                  : "Snapshot"}
              </span>
            )}
          </span>
          <span className="block font-mono text-[11px] text-neutral-600">
            {time}
            {snapshot.reason === "before-restore" && snapshot.backupOf && (
              <>
                {" · backup of "}
                <span className="text-neutral-500">{snapshot.backupOf.slice(0, 8)}</span>
              </>
            )}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[11px]">
          {additions > 0 && <span className="text-emerald-400">+{additions}</span>}
          {deletions > 0 && (
            <span className="ml-1.5 text-rose-400">−{deletions}</span>
          )}
          {additions === 0 && deletions === 0 && (
            <span className="text-neutral-600">no change</span>
          )}
        </span>
        <span className="shrink-0 pl-1 font-mono text-[12px] text-neutral-600">
          {expanded ? "−" : "+"}
        </span>
      </button>

      {expanded && (
        <div className="pb-3 pr-2">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[11px] text-neutral-500">
              {prevId
                ? `Turn delta vs snapshot ${prevId.slice(0, 8)}`
                : "Turn delta vs HEAD"}
            </span>
            <div className="flex gap-2">
              <PreviewButton folder={folder} snapshotId={snapshot.id} />
              <button
                type="button"
                onClick={onRestore}
                disabled={restoring}
                className="rounded border border-rose-900/60 px-2 py-1 font-mono text-[11px] text-rose-400 active:bg-rose-950/30 disabled:opacity-50"
              >
                {restoring ? "Restoring…" : "Restore here"}
              </button>
            </div>
          </div>
          {diff === undefined ? (
            <div className="py-4 text-center font-mono text-[11px] text-neutral-500">
              Loading diff…
            </div>
          ) : diff.ok ? (
            <SnapshotDiff files={diff.files} />
          ) : (
            <div className="py-2 font-mono text-[11px] text-rose-400">{diff.message}</div>
          )}
        </div>
      )}
    </div>
  );
}

function SnapshotDiff({ files }: { files: DiffFile[] }) {
  if (files.length === 0) {
    return (
      <div className="py-2 font-mono text-[11px] text-neutral-600">
        No file changes in this turn.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {files.map((f) => (
        <div
          key={f.path}
          className="rounded border border-neutral-800 bg-neutral-950"
        >
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-2 py-1 font-mono text-[11px]">
            <span className="text-emerald-400">+{f.additions}</span>
            <span className="text-rose-400">−{f.deletions}</span>
            <span className="min-w-0 flex-1 truncate text-neutral-300">{f.path}</span>
          </div>
          <DiffBody file={f} bordered={false} maxHeight={false} />
        </div>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------
// Preview vs current
// -----------------------------------------------------------------------

function PreviewButton({ folder, snapshotId }: { folder: string; snapshotId: string }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<DiffPayload | null>(null);

  async function openPreview() {
    setOpen(true);
    if (diff) return;
    const result = await fetchTimelineDiff(folder, snapshotId, undefined);
    setDiff(result);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={openPreview}
        className="rounded border border-neutral-800 px-2 py-1 font-mono text-[11px] text-neutral-400 active:bg-neutral-900"
      >
        Preview vs current
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex h-[85vh] w-full max-w-2xl flex-col rounded border border-neutral-800 bg-neutral-950">
        <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
          <span className="font-mono text-[12px] text-neutral-300">
            Snapshot {snapshotId.slice(0, 8)} vs current
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-neutral-500 active:text-neutral-300"
          >
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {diff === null ? (
            <div className="py-8 text-center font-mono text-[11px] text-neutral-500">
              Loading…
            </div>
          ) : diff.ok ? (
            <SnapshotDiff files={diff.files} />
          ) : (
            <div className="font-mono text-[11px] text-rose-400">{diff.message}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Restore notice
// -----------------------------------------------------------------------

function RestoreNotice({
  snapshotId,
  backupId,
  onDismiss,
}: {
  snapshotId: string;
  backupId: string;
  onDismiss: () => void;
}) {
  return (
    <div className="shrink-0 border-b border-emerald-900/60 bg-emerald-950/20 px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-emerald-300">
          Restored to snapshot {snapshotId.slice(0, 8)}.
        </span>
        <button type="button" onClick={onDismiss} className="text-[12px] text-emerald-500">
          Dismiss
        </button>
      </div>
      <div className="font-mono text-[11px] text-emerald-500/80">
        Backup created: {backupId.slice(0, 8)}.
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Data fetching
// -----------------------------------------------------------------------

type DiffPayload =
  | {
      ok: true;
      base: string;
      baseLocal: boolean;
      files: DiffFile[];
      summary: { files: number; additions: number; deletions: number; untracked: number };
    }
  | { ok: false; reason: "not-repo" | "no-base" | "error"; message: string };

interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: number;
}

async function fetchTimelineDiff(
  folder: string,
  fromId: string | undefined,
  toId: string | undefined,
): Promise<DiffPayload> {
  const params = new URLSearchParams({ folder });
  if (fromId) params.set("from", fromId);
  if (toId) params.set("to", toId);
  const res = await fetch(`/api/timeline-diff?${params.toString()}`);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, reason: "error", message: data.error ?? "Failed to load diff" };
  }
  return (await res.json()) as DiffPayload;
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function formatTime(at: number): string {
  const d = new Date(at);
  const now = Date.now();
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
