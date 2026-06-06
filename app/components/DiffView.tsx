import { useEffect, useMemo, useState } from "react";
import type { DiffFile, DiffLine as DiffLineType } from "~/lib/chat-types";

/**
 * The full diff view for a single folder's worktree.
 *
 * Mobile-first:
 *   - One file per row, full-width
 *   - Tap the row header to expand / collapse the body
 *   - The body shows the same line coloring as the inline
 *     chat-edit previews so a user recognizes it immediately
 *
 * The list is fetched on mount. A "Refresh" button re-fetches
 * the payload (handy while the agent is making edits — the
 * diff changes during a turn and the user might want to see
 * the latest without leaving the screen).
 *
 * Files default to expanded if they're small (<50 lines of
 * diff) and collapsed otherwise. The user can override per
 * file with the header tap.
 */
export function DiffView({
  folder,
  initial,
}: {
  folder: string;
  initial: DiffPayload;
}) {
  const [payload, setPayload] = useState<DiffPayload>(initial);
  const [refreshing, setRefreshing] = useState(false);
  // When the user navigates between folders (or the URL
  // re-runs the loader with a different `initial` prop), we
  // need to reset the payload and the open-file set so the
  // new diff renders. Without this, the component would keep
  // showing the previous folder's diff because `useState`
  // only consumes its initializer on the first render.
  useEffect(() => {
    setPayload(initial);
    if (initial.ok) {
      const out = new Set<string>();
      for (const f of initial.files) {
        const total = f.hunks.reduce((n, h) => n + h.lines.length, 0);
        if (total > 0 && total < 50) out.add(f.path);
      }
      setOpenSet(out);
    } else {
      setOpenSet(new Set());
    }
  }, [initial]);
  const [openSet, setOpenSet] = useState<Set<string>>(() => {
    // Default: expand files whose total diff body is < 50 lines.
    // We narrow the payload here: if the SSR'd payload is an
    // error/empty result, we just start with an empty set; the
    // render path will show the appropriate empty state.
    if (!initial.ok) return new Set<string>();
    const out = new Set<string>();
    for (const f of initial.files) {
      const total = f.hunks.reduce((n, h) => n + h.lines.length, 0);
      if (total > 0 && total < 50) out.add(f.path);
    }
    return out;
  });

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await fetch(
        `/api/folder-diff?folder=${encodeURIComponent(folder)}`,
      );
      if (res.ok) {
        const next = (await res.json()) as DiffPayload;
        setPayload(next);
        // Drop opens for files that no longer exist. Skip the
        // prune on an error payload — the file list isn't
        // available, and the empty state will replace the
        // open file rows anyway.
        if (next.ok) {
          setOpenSet((prev) => {
            const paths = new Set(next.files.map((f) => f.path));
            const filtered = new Set<string>();
            for (const p of prev) if (paths.has(p)) filtered.add(p);
            return filtered;
          });
        }
      }
    } catch {
      // Network error: leave the existing payload in place.
    } finally {
      setRefreshing(false);
    }
  }

  if (!payload.ok) {
    return <DiffEmpty reason={payload.reason} message={payload.message} />;
  }
  const { files, summary, base, baseLocal } = payload;
  if (files.length === 0) {
    return <DiffClean base={base} baseLocal={baseLocal} />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DiffHeader
        summary={summary}
        base={base}
        baseLocal={baseLocal}
        refreshing={refreshing}
        onRefresh={refresh}
      />
      <ul className="flex-1 overflow-y-auto">
        {files.map((f) => (
          <DiffFileRow
            key={f.path}
            file={f}
            open={openSet.has(f.path)}
            onToggle={() => {
              setOpenSet((prev) => {
                const next = new Set(prev);
                if (next.has(f.path)) next.delete(f.path);
                else next.add(f.path);
                return next;
              });
            }}
          />
        ))}
      </ul>
    </div>
  );
}

// -----------------------------------------------------------------------
// Header
// -----------------------------------------------------------------------

function DiffHeader({
  summary,
  base,
  baseLocal,
  refreshing,
  onRefresh,
}: {
  summary: { files: number; additions: number; deletions: number; untracked: number };
  base: string;
  baseLocal: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-neutral-800 px-3 py-2.5">
      <div className="min-w-0 flex-1 font-mono text-[12px] text-neutral-300">
        <span className="text-emerald-400">+{summary.additions}</span>
        {" "}
        <span className="text-rose-400">−{summary.deletions}</span>
        <span className="ml-2 text-neutral-500">
          {summary.files === 1 ? "1 file" : `${summary.files} files`}
        </span>
        {summary.untracked > 0 && (
          <span className="ml-2 text-neutral-600">
            ({summary.untracked} untracked)
          </span>
        )}
        <span className="ml-2 text-neutral-600">vs</span>{" "}
        <span className="text-neutral-400">{base}</span>
        {!baseLocal && <span className="ml-1 text-neutral-600">remote</span>}
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label="Refresh diff"
        title="Refresh"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-neutral-800 text-neutral-400 active:bg-neutral-900 disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          className={
            "inline-block font-mono text-[14px] leading-none " +
            (refreshing ? "animate-spin" : "")
          }
        >
          ↻
        </span>
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------
// File row
// -----------------------------------------------------------------------

function DiffFileRow({
  file,
  open,
  onToggle,
}: {
  file: DiffFile;
  open: boolean;
  onToggle: () => void;
}) {
  const base = basename(file.path);
  const dir = dirOf(file.path);
  const status = statusBadge(file.status);
  return (
    <li className="border-b border-neutral-900">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left active:bg-neutral-900"
      >
        <span
          className={
            "inline-block w-12 shrink-0 text-right font-mono text-[10px] tabular-nums " +
            (file.additions > 0 ? "text-emerald-400" : "text-neutral-700")
          }
        >
          +{file.additions}
        </span>
        <span
          className={
            "inline-block w-12 shrink-0 text-right font-mono text-[10px] tabular-nums " +
            (file.deletions > 0 ? "text-rose-400" : "text-neutral-700")
          }
        >
          −{file.deletions}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className={"mr-2 inline-block font-mono text-[10px] " + status.color}>
            {status.label}
          </span>
          <span className="font-mono text-[13px] text-neutral-100">{base}</span>
          {dir && (
            <span className="ml-1.5 font-mono text-[11px] text-neutral-600">
              {dir}
            </span>
          )}
          {file.oldPath && (
            <span className="ml-1.5 font-mono text-[10px] text-neutral-600">
              ← {basename(file.oldPath)}
            </span>
          )}
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-[12px] text-neutral-600"
        >
          {open ? "−" : "+"}
        </span>
      </button>
      {open && (
        <div className="px-1 pb-2">
          {file.hunks.length === 0 ? (
            <div className="px-3 py-2 font-mono text-[11px] text-neutral-600">
              No body (file is binary or empty).
            </div>
          ) : (
            <DiffBody file={file} />
          )}
          {file.truncated && (
            <div className="mt-1 px-3 font-mono text-[11px] text-amber-400">
              Diff truncated — file is large.
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// -----------------------------------------------------------------------
// Diff body
// -----------------------------------------------------------------------

/**
 * The rendered body of one file. The file's path is shown
 * in the row header above (the parent `<DiffFileRow>`); we
 * deliberately don't repeat it here so the user only sees
 * the path once per file. We group the hunks under a dim
 * hunk header so the user can see which `@@` block they're
 * in while scrolling.
 */
function DiffBody({ file }: { file: DiffFile }) {
  return (
    <div className="overflow-hidden border border-neutral-800 bg-neutral-950">
      <pre className="max-h-[70vh] overflow-auto font-mono text-[12px] leading-snug">
        {file.hunks.map((h, i) => (
          <div key={i}>
            <div className="bg-neutral-900/60 px-2 py-0.5 text-[11px] text-neutral-600">
              {h.header}
            </div>
            {h.lines.map((l, j) => (
              <DiffLine key={j} l={l} />
            ))}
          </div>
        ))}
      </pre>
    </div>
  );
}

function DiffLine({ l }: { l: DiffLineType }) {
  // The `+`/`-` gutter helps mobile users distinguish additions
  // from deletions in bright sunlight. Color is supplementary,
  // not the only signal.
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
      <span className="mr-2 select-none pl-2 text-neutral-600">
        {l.kind === "del" ? "-" : l.kind === "add" ? "+" : " "}
      </span>
      {l.text || " "}
    </div>
  );
}

// -----------------------------------------------------------------------
// Empty / clean / error states
// -----------------------------------------------------------------------

function DiffClean({
  base,
  baseLocal,
}: {
  base: string;
  baseLocal: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="font-mono text-[12px] uppercase tracking-widest text-emerald-400">
        Clean
      </div>
      <div className="text-sm text-neutral-300">No changes vs {base}</div>
      <div className="font-mono text-[11px] text-neutral-600">
        {baseLocal ? "local branch" : "remote branch"} · HEAD is at the same
        state as the base
      </div>
    </div>
  );
}

function DiffEmpty({
  reason,
  message,
}: {
  reason: "not-repo" | "no-base" | "error";
  message: string;
}) {
  const headline =
    reason === "not-repo"
      ? "Not a git repository"
      : reason === "no-base"
        ? "No base branch"
        : "Diff unavailable";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="font-mono text-[12px] uppercase tracking-widest text-neutral-500">
        {headline}
      </div>
      <div className="max-w-xs text-sm text-neutral-400">{message}</div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "" : p.slice(0, i + 1);
}

function statusBadge(status: DiffFile["status"]): { label: string; color: string } {
  switch (status) {
    case "added":
      return { label: "ADD", color: "text-emerald-400" };
    case "deleted":
      return { label: "DEL", color: "text-rose-400" };
    case "modified":
      return { label: "MOD", color: "text-amber-400" };
    case "renamed":
      return { label: "REN", color: "text-blue-400" };
    case "copied":
      return { label: "CPY", color: "text-blue-400" };
    case "typechange":
      return { label: "TYP", color: "text-purple-400" };
    case "untracked":
      return { label: "NEW", color: "text-emerald-400" };
  }
}

// -----------------------------------------------------------------------
// Wire type for the SSR'd payload and the client-side fetch
// -----------------------------------------------------------------------

export type DiffPayload =
  | {
      ok: true;
      base: string;
      baseLocal: boolean;
      files: DiffFile[];
      summary: { files: number; additions: number; deletions: number; untracked: number };
    }
  | {
      ok: false;
      reason: "not-repo" | "no-base" | "error";
      message: string;
    };
