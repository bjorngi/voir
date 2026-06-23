import { useMemo, useState } from "react";
import type { DiffFile } from "~/lib/chat-types";
import type { SnapshotSummary } from "~/lib/timeline.server";

/**
 * Folder-level timeline view.
 *
 * Each user prompt that ends an agent turn becomes a snapshot.
 * Cards show the prompt, turn number, and a diff-vs-HEAD summary.
 * Tapping a card expands the per-file diff for that turn (previous
 * snapshot → this snapshot). A "Restore here" button resets the
 * worktree to that snapshot after first capturing a backup.
 */
export function TimelineView({
  folder,
  snapshots,
}: {
  folder: string;
  snapshots: SnapshotSummary[];
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Map<string, DiffPayload>>(new Map());
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<{
    snapshotId: string;
    backupId: string;
  } | null>(null);

  async function expand(id: string, prevId?: string) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (diffs.has(id)) return;
    const result = await fetchDiff(folder, prevId, id);
    setDiffs((prev) => {
      const next = new Map(prev);
      next.set(id, result);
      return next;
    });
  }

  async function restore(id: string) {
    if (!confirm("Restore the worktree to this snapshot? Current state will be backed up first.")) {
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
      } else {
        const err = (await res.json()) as { error?: string };
        alert(err.error ?? "Restore failed");
      }
    } finally {
      setRestoring(null);
    }
  }

  if (snapshots.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="font-mono text-[12px] uppercase tracking-widest text-neutral-500">
          Timeline empty
        </div>
        <div className="max-w-xs text-sm text-neutral-400">
          Snapshots are captured automatically at the end of each agent turn.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TimelineHeader count={snapshots.length} />
      <ul className="flex-1 overflow-y-auto">
        {snapshots.map((s, i) => {
          const prevId = i < snapshots.length - 1 ? snapshots[i + 1].id : undefined;
          return (
            <SnapshotCard
              key={s.id}
              folder={folder}
              snapshot={s}
              prevId={prevId}
              expanded={expandedId === s.id}
              diff={diffs.get(s.id)}
              restoring={restoring === s.id}
              onExpand={() => expand(s.id, prevId)}
              onRestore={() => restore(s.id)}
            />
          );
        })}
      </ul>
      {restoreNotice && (
        <RestoreNotice
          snapshotId={restoreNotice.snapshotId}
          backupId={restoreNotice.backupId}
          onDismiss={() => setRestoreNotice(null)}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------
// Header
// -----------------------------------------------------------------------

function TimelineHeader({ count }: { count: number }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-neutral-800 px-3 py-2.5">
      <div className="font-mono text-[12px] text-neutral-300">
        {count === 1 ? "1 snapshot" : `${count} snapshots`}
      </div>
      <div className="flex-1 text-right font-mono text-[11px] text-neutral-600">
        local · git-backed
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Snapshot card
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
  const files = snapshot.files ?? 0;
  const additions = snapshot.additions ?? 0;
  const deletions = snapshot.deletions ?? 0;

  return (
    <li className="border-b border-neutral-900">
      <button
        type="button"
        onClick={onExpand}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-3 text-left active:bg-neutral-900"
      >
        <span className="w-12 shrink-0 text-right font-mono text-[11px] text-neutral-500">
          #{snapshot.turn}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-neutral-200">
            {snapshot.prompt ?? (
              <span className="italic text-neutral-500">
                {snapshot.reason === "before-restore"
                  ? "Pre-restore backup"
                  : "Snapshot"}
              </span>
            )}
          </span>
          <span className="block font-mono text-[11px] text-neutral-500">
            {time}
            {snapshot.reason === "before-restore" && snapshot.backupOf && (
              <>
                {" · backup of "}
                <span className="text-neutral-400">{snapshot.backupOf.slice(0, 8)}</span>
              </>
            )}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[11px]">
          {additions > 0 && <span className="text-emerald-400">+{additions}</span>}
          {deletions > 0 && (
            <span className="ml-1.5 text-rose-400">−{deletions}</span>
          )}
          {additions === 0 && deletions === 0 && files > 0 && (
            <span className="text-neutral-500">{files} files</span>
          )}
          {additions === 0 && deletions === 0 && files === 0 && (
            <span className="text-neutral-600">no change</span>
          )}
        </span>
        <span className="shrink-0 pl-1 font-mono text-[12px] text-neutral-600">
          {expanded ? "−" : "+"}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[11px] text-neutral-500">
              {prevId
                ? `Turn delta vs snapshot ${prevId.slice(0, 8)}`
                : "Turn delta vs initial worktree"}
            </span>
            <div className="flex gap-2">
              <DiffPreviewButton folder={folder} snapshotId={snapshot.id} />
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
            <div className="py-2 font-mono text-[11px] text-rose-400">
              {diff.message}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// -----------------------------------------------------------------------
// Diff rendering
// -----------------------------------------------------------------------

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
        <div key={f.path} className="overflow-hidden border border-neutral-800 bg-neutral-950">
          <div className="flex items-center gap-2 border-b border-neutral-800 px-2 py-1 font-mono text-[11px]">
            <span className="text-emerald-400">+{f.additions}</span>
            <span className="text-rose-400">−{f.deletions}</span>
            <span className="min-w-0 flex-1 truncate text-neutral-300">{f.path}</span>
          </div>
          <pre className="max-h-[40vh] overflow-auto p-1 font-mono text-[11px] leading-snug">
            {f.hunks.map((h, i) => (
              <div key={i}>
                <div className="bg-neutral-900/60 px-1 py-0.5 text-neutral-600">
                  {h.header}
                </div>
                {h.lines.map((l, j) => (
                  <DiffLine key={j} l={l} />
                ))}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}

function DiffLine({ l }: { l: import("~/lib/chat-types").DiffLine }) {
  return (
    <div
      className={
        l.kind === "del"
          ? "bg-rose-950/40 text-rose-300"
          : l.kind === "add"
            ? "bg-emerald-950/40 text-emerald-300"
            : "text-neutral-400"
      }
    >
      <span className="mr-2 select-none pl-1 text-neutral-600">
        {l.kind === "del" ? "-" : l.kind === "add" ? "+" : " "}
      </span>
      {l.text || " "}
    </div>
  );
}

// -----------------------------------------------------------------------
// Preview vs current
// -----------------------------------------------------------------------

function DiffPreviewButton({
  folder,
  snapshotId,
}: {
  folder: string;
  snapshotId: string;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<DiffPayload | null>(null);

  async function openPreview() {
    setOpen(true);
    if (diff) return;
    const result = await fetchDiff(folder, snapshotId, undefined);
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
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded border border-neutral-800 bg-neutral-950">
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
    <div className="shrink-0 border-t border-emerald-900/60 bg-emerald-950/20 px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-emerald-300">
          Restored to snapshot {snapshotId.slice(0, 8)}.
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[12px] text-emerald-500"
        >
          Dismiss
        </button>
      </div>
      <div className="font-mono text-[11px] text-emerald-500/80">
        Backup created: {backupId.slice(0, 8)}. You can restore it from the timeline.
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

async function fetchDiff(
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
