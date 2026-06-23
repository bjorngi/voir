import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isGitRepo,
  parseUnifiedDiff,
  type DiffFile,
  type DiffResult,
} from "./diff.server";

/**
 * Local, git-backed timeline.
 *
 * Each registered Voir folder/worktree gets a private chain of
 * lightweight commits under refs/voir/timeline/<folder-hash>.
 * These commits are invisible to normal git history (they don't
 * touch HEAD or any user branch) but live in the repo's object
 * store, so deduplication and diffing are free.
 *
 * A snapshot is captured at the end of every agent turn. Its tree
 * is the complete worktree at that moment (tracked and untracked),
 * staged to a temporary index so the user's real git index is never
 * touched.
 *
 * Commit message format:
 *   voir: turn N — <prompt>
 *
 *   {"id":"...","at":...,"reason":"...","sessionId":"...","prompt":"...","turn":N}
 */

/** Synthetic git identity for timeline commits. */
const VOIR_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "voir",
  GIT_AUTHOR_EMAIL: "voir@local",
  GIT_COMMITTER_NAME: "voir",
  GIT_COMMITTER_EMAIL: "voir@local",
} as const;

/** Hard cap on a single git invocation. */
const GIT_TIMEOUT_MS = 10_000;

/** Maximum diff body we keep in memory for preview. */
const MAX_DIFF_BYTES = 4 * 1024 * 1024;

export interface SnapshotMeta {
  id: string;
  at: number;
  reason: "turn-end" | "before-restore" | "manual";
  sessionId?: string;
  prompt?: string;
  plan?: string[];
  turn: number;
  /** For before-restore snapshots: the id being restored to. */
  backupOf?: string;
}

export interface Snapshot {
  id: string;
  ref: string;
  commit: string;
  tree: string;
  meta: SnapshotMeta;
}

export interface SnapshotSummary {
  id: string;
  at: number;
  turn: number;
  reason: SnapshotMeta["reason"];
  prompt?: string;
  sessionId?: string;
  files?: number;
  additions?: number;
  deletions?: number;
  backupOf?: string;
}

/**
 * Capture a new snapshot of the current worktree state.
 *
 * The user's git index and HEAD are left untouched. All files
 * (tracked and untracked) are staged into a temporary index, a tree
 * is written, and a lightweight commit is created that chains off
 * the previous snapshot for this folder.
 */
export async function capture(
  folder: string,
  meta: Omit<SnapshotMeta, "id" | "at" | "turn">,
): Promise<Snapshot | null> {
  if (!isGitRepo(folder)) return null;
  const hash = folderHash(folder);
  const id = randomUUID();
  const at = Date.now();
  const previous = await latestSnapshotCommit(folder, hash);
  const turn = (previous?.turn ?? 0) + 1;
  const fullMeta: SnapshotMeta = { ...meta, id, at, turn };

  const tmpIndex = tmpIndexPath(folder);
  try {
    // Stage the entire current worktree into a temporary index.
    await git(folder, ["add", "-A"], { index: tmpIndex });
    const tree = (await git(folder, ["write-tree"], { index: tmpIndex })).trim();

    const message = buildCommitMessage(fullMeta);
    const args = ["commit-tree", tree];
    if (previous?.commit) {
      args.push("-p", previous.commit);
    }
    args.push("-m", message);

    const commit = (await git(folder, args, { env: VOIR_GIT_IDENTITY })).trim();
    const ref = refName(hash, id);
    await git(folder, ["update-ref", ref, commit]);

    return { id, ref, commit, tree, meta: fullMeta };
  } catch (err) {
    console.error("[timeline] capture failed:", (err as Error).message);
    return null;
  } finally {
    await rm(tmpIndex, { force: true });
  }
}

/**
 * List all snapshots for a folder, newest first.
 *
 * Stats on each card represent the turn delta: changes between
 * this snapshot and the one before it (or HEAD for the first
 * snapshot), so the user sees what changed during that turn.
 */
export async function list(folder: string): Promise<SnapshotSummary[]> {
  if (!isGitRepo(folder)) return [];
  const hash = folderHash(folder);
  const refs = await listRefs(folder, hash);
  const snapshots: Snapshot[] = [];
  for (const ref of refs) {
    const snap = await readSnapshot(folder, ref);
    if (snap) snapshots.push(snap);
  }
  snapshots.sort((a, b) => a.meta.turn - b.meta.turn);
  const out: SnapshotSummary[] = [];
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const previousCommit = snapshots[i + 1]?.commit ?? "HEAD";
    const stats = await diffStat(folder, previousCommit, snap.commit);
    out.push({
      id: snap.meta.id,
      at: snap.meta.at,
      turn: snap.meta.turn,
      reason: snap.meta.reason,
      prompt: snap.meta.prompt,
      sessionId: snap.meta.sessionId,
      backupOf: snap.meta.backupOf,
      files: stats.files,
      additions: stats.additions,
      deletions: stats.deletions,
    });
  }
  return out.sort((a, b) => b.turn - a.turn);
}

/**
 * Diff two snapshots. `toId` may be omitted to diff against the
 * current worktree state.
 */
export async function diffSnapshots(
  folder: string,
  fromId: string,
  toId?: string,
): Promise<DiffResult> {
  if (!isGitRepo(folder)) {
    return { ok: false, reason: "not-repo", message: "Not a git repository" };
  }
  const fromSnap = fromId
    ? await findSnapshot(folder, fromId)
    : { commit: "HEAD" } as { commit: string };
  if (!fromSnap) {
    return { ok: false, reason: "error", message: `Unknown snapshot: ${fromId}` };
  }
  const toCommit = toId
    ? (await findSnapshot(folder, toId))?.commit
    : await currentTreeCommit(folder);
  if (!toCommit) {
    return {
      ok: false,
      reason: "error",
      message: toId ? `Unknown snapshot: ${toId}` : "Could not capture current state",
    };
  }

  const body = await gitDiffBody(folder, fromSnap.commit, toCommit);
  const files = buildDiffFiles(body);
  const summary = countDiff(files);
  return {
    ok: true,
    base: fromId ? `snapshot ${fromId.slice(0, 8)}` : "HEAD",
    baseLocal: true,
    files,
    summary: {
      files: summary.files,
      additions: summary.additions,
      deletions: summary.deletions,
      untracked: summary.untracked,
    },
  };
}

/**
 * Restore the worktree to a snapshot. Always captures an
 * automatic backup of the current state first so the restore
 * is reversible.
 */
export async function restore(
  folder: string,
  snapshotId: string,
): Promise<{ ok: true; backup: SnapshotSummary } | { ok: false; error: string }> {
  if (!isGitRepo(folder)) {
    return { ok: false, error: "Not a git repository" };
  }
  const target = await findSnapshot(folder, snapshotId);
  if (!target) {
    return { ok: false, error: `Unknown snapshot: ${snapshotId}` };
  }

  // 1. Capture a pre-restore backup of the current worktree.
  const backup = await capture(folder, {
    reason: "before-restore",
    backupOf: snapshotId,
  });
  if (!backup) {
    return { ok: false, error: "Could not capture pre-restore backup" };
  }

  // 2. Reset the working tree to the snapshot's tree.
  try {
    await restoreWorktreeToTree(folder, target.tree);
    return {
      ok: true,
      backup: {
        id: backup.meta.id,
        at: backup.meta.at,
        turn: backup.meta.turn,
        reason: backup.meta.reason,
        backupOf: backup.meta.backupOf,
      },
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Find a snapshot by id. Returns null if not found or not a git repo.
 */
export async function findSnapshot(
  folder: string,
  id: string,
): Promise<Snapshot | null> {
  if (!isGitRepo(folder)) return null;
  const hash = folderHash(folder);
  const ref = refName(hash, id);
  try {
    return await readSnapshot(folder, ref);
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------
// Git plumbing helpers
// -----------------------------------------------------------------------

function folderHash(folder: string): string {
  return createHash("sha256").update(folder).digest("hex").slice(0, 16);
}

function refName(hash: string, id: string): string {
  return `refs/voir/timeline/${hash}/${id}`;
}

function tmpIndexPath(folder: string): string {
  return join(tmpdir(), `voir-index-${folderHash(folder)}-${process.hrtime.bigint()}.tmp`);
}

function buildCommitMessage(meta: SnapshotMeta): string {
  const preview = meta.prompt
    ? meta.prompt.length > 60
      ? meta.prompt.slice(0, 57) + "..."
      : meta.prompt
    : meta.reason === "before-restore"
      ? `backup before restore to ${meta.backupOf?.slice(0, 8) ?? "?"}`
      : meta.reason;
  const subject = `voir: turn ${meta.turn} — ${preview}`;
  const body = JSON.stringify(meta);
  return `${subject}\n\n${body}`;
}

async function listRefs(folder: string, hash: string): Promise<string[]> {
  try {
    const out = await git(folder, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/voir/timeline/${hash}/`,
    ]);
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function latestSnapshotCommit(
  folder: string,
  hash: string,
): Promise<{ commit: string; turn: number } | null> {
  const refs = await listRefs(folder, hash);
  let best: { commit: string; turn: number } | null = null;
  for (const ref of refs) {
    const snap = await readSnapshot(folder, ref);
    if (!snap) continue;
    if (!best || snap.meta.turn > best.turn) {
      best = { commit: snap.commit, turn: snap.meta.turn };
    }
  }
  return best;
}

async function readSnapshot(folder: string, ref: string): Promise<Snapshot | null> {
  let commit: string;
  let message: string;
  let tree: string;
  try {
    commit = (await git(folder, ["rev-parse", ref])).trim();
    message = (await git(folder, ["cat-file", "-p", commit])).trim();
    tree = (await git(folder, ["rev-parse", `${commit}^{tree}`])).trim();
  } catch {
    return null;
  }
  const meta = parseCommitMessage(message);
  if (!meta) return null;
  return { id: meta.id, ref, commit, tree, meta };
}

function parseCommitMessage(message: string): SnapshotMeta | null {
  const parts = message.split("\n\n");
  const body = parts[parts.length - 1];
  try {
    const parsed = JSON.parse(body) as SnapshotMeta;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.at === "number" &&
      typeof parsed.turn === "number"
    ) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

async function currentTreeCommit(folder: string): Promise<string | null> {
  const tmpIndex = tmpIndexPath(folder);
  try {
    await git(folder, ["add", "-A"], { index: tmpIndex });
    return (await git(folder, ["write-tree"], { index: tmpIndex })).trim();
  } catch (err) {
    console.error("[timeline] current tree error:", (err as Error).message);
    return null;
  } finally {
    await rm(tmpIndex, { force: true });
  }
}

async function gitDiffBody(
  folder: string,
  fromCommit: string,
  toCommit: string,
): Promise<string> {
  try {
    return await git(folder, [
      "diff",
      "--unified=3",
      "--no-ext-diff",
      fromCommit,
      toCommit,
    ]);
  } catch (err) {
    return "";
  }
}

function buildDiffFiles(body: string): DiffFile[] {
  const hunksByPath = parseUnifiedDiff(body);
  const files: DiffFile[] = [];
  for (const [path, hunks] of hunksByPath.entries()) {
    let additions = 0;
    let deletions = 0;
    for (const h of hunks) {
      for (const l of h.lines) {
        if (l.kind === "add") additions++;
        else if (l.kind === "del") deletions++;
      }
    }
    files.push({
      path,
      status: inferStatus(hunks, additions, deletions),
      additions,
      deletions,
      hunks,
    });
  }
  return files;
}

function inferStatus(
  hunks: import("./diff.server").DiffHunk[],
  additions: number,
  deletions: number,
): DiffFile["status"] {
  if (hunks.length === 0) return "untracked";
  if (additions > 0 && deletions === 0) return "added";
  if (deletions > 0 && additions === 0) return "deleted";
  return "modified";
}

function countDiff(files: DiffFile[]) {
  let filesCount = 0;
  let additions = 0;
  let deletions = 0;
  let untracked = 0;
  for (const f of files) {
    filesCount++;
    additions += f.additions;
    deletions += f.deletions;
    if (f.status === "untracked") untracked++;
  }
  return { files: filesCount, additions, deletions, untracked };
}

async function restoreWorktreeToTree(folder: string, tree: string): Promise<void> {
  // List the files that should exist after restore.
  let listOut = "";
  try {
    listOut = await git(folder, ["ls-tree", "-r", "--name-only", tree]);
  } catch (err) {
    throw new Error(`Could not list snapshot tree: ${(err as Error).message}`);
  }
  const snapshotFiles = new Set(
    listOut
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  // Write every file from the snapshot tree into the worktree.
  const tmpIndex = tmpIndexPath(folder);
  try {
    await git(folder, ["read-tree", tree], { index: tmpIndex });
    await git(folder, ["checkout-index", "-f", "-a"], { index: tmpIndex });
  } finally {
    await rm(tmpIndex, { force: true });
  }

  // Delete files present in worktree but absent from snapshot.
  const currentFiles = await listWorktreeFiles(folder);
  for (const f of currentFiles) {
    if (!snapshotFiles.has(f)) {
      await rm(join(folder, f), { force: true }).catch(() => {});
    }
  }

  // Clear the user's real index so the restored state shows as
  // uncommitted changes against HEAD. The user can `git add -A`
  // when they're ready to commit.
  await git(folder, ["reset"]).catch((err) => {
    console.warn("[timeline] reset index after restore:", (err as Error).message);
  });
}

async function listWorktreeFiles(folder: string): Promise<string[]> {
  try {
    const [tracked, untracked] = await Promise.all([
      git(folder, ["ls-files"]).catch(() => ""),
      git(folder, ["ls-files", "--others", "--exclude-standard"]).catch(() => ""),
    ]);
    const all = new Set<string>();
    for (const line of tracked.split("\n").concat(untracked.split("\n"))) {
      const trimmed = line.trim();
      if (trimmed) all.add(trimmed);
    }
    return Array.from(all).sort();
  } catch {
    return [];
  }
}

async function diffStat(
  folder: string,
  fromCommit: string,
  toCommit: string,
): Promise<{ files: number; additions: number; deletions: number }> {
  try {
    const out = await git(folder, ["diff", "--shortstat", fromCommit, toCommit]);
    const m =
      /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(
        out,
      );
    if (!m) return { files: 0, additions: 0, deletions: 0 };
    return {
      files: Number(m[1]) || 0,
      additions: Number(m[2]) || 0,
      deletions: Number(m[3]) || 0,
    };
  } catch {
    return { files: 0, additions: 0, deletions: 0 };
  }
}

// -----------------------------------------------------------------------
// Low-level git invocation
// -----------------------------------------------------------------------

interface GitOptions {
  index?: string;
  env?: Record<string, string>;
}

async function git(folder: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  if (opts.index) {
    env.GIT_INDEX_FILE = opts.index;
  }
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", folder, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_DIFF_BYTES,
        encoding: "utf8",
        env,
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout ?? "");
      },
    );
  });
}
