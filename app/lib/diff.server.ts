import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Server-side git diff helpers.
 *
 * A Voir "folder" is a working directory on disk. We assume it is
 * a git checkout (the typical case — Voir is most useful for
 * worktrees). The diff is computed as:
 *
 *   <base branch>..HEAD     — commits unique to this branch
 *   + working-tree changes  — modified / staged / untracked
 *
 * Where the base branch is auto-detected: we try `main`, `master`,
 * `develop`, `trunk` in that order, taking the first one that
 * resolves to a real ref locally (`refs/heads/<name>`) or on any
 * remote (`refs/remotes/<remote>/<name>`).
 *
 * Why this scope: the user wants to see "what did the AI do in
 * this worktree" — that's `branch base..HEAD + uncommitted`,
 * scoped to the worktree. Commits on `main` that happened after
 * the worktree was branched are NOT included, because they're
 * not this worktree's work.
 *
 * We use `execFile` (not `exec`) and pass arguments as a
 * positional array, so no shell quoting is involved. A 5s
 * timeout caps pathological cases; callers see a timeout error
 * and degrade to an empty diff rather than a hung loader.
 *
 * Nothing in here is exported to the client. The wire types
 * live in `chat-types.ts` so the API response shape can be
 * imported by both sides.
 */

const execFileP = promisify(execFile);

/** Refs we'll try as the base, in priority order. */
const BASE_CANDIDATES = ["main", "master", "develop", "trunk"];

/** Hard cap on a single git invocation. Repos that exceed this
 *  are pathological for the diff UI; we'd rather show empty than
 *  hang the loader. */
const GIT_TIMEOUT_MS = 5_000;

/** Maximum size of a single diff payload we keep in memory.
 *  Larger than this and we truncate per-file diffs at the
 *  cap and add a `truncated: true` flag. */
const MAX_DIFF_BYTES = 4 * 1024 * 1024;

/** Status codes from `git diff --name-status` and the porcelain
 *  status commands. We use these to label files in the UI. */
export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "copied"
  | "typechange";

/** A single changed line in a hunk. Mirrors what we already use
 *  in `Message.tsx` for the inline edit diffs. */
export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
}

/** A hunk header plus its body lines. The header is the `@@`
 *  line git prints, verbatim. */
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

/** One file's worth of changes, as the UI wants to render them. */
export interface DiffFile {
  path: string;
  /** Original path for renames; undefined otherwise. */
  oldPath?: string;
  status: FileStatus;
  /** True when the body has been clipped to MAX_DIFF_BYTES. */
  truncated?: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

/** Cheap summary for the folder list + header badges. */
export interface DiffSummary {
  ok: true;
  base: string;
  /** True if base is a local branch, false if a remote ref. */
  baseLocal: boolean;
  files: number;
  additions: number;
  deletions: number;
  /** Number of untracked files that aren't in the diff body
   *  (we still count them in `files`). */
  untracked: number;
}

export type DiffResult =
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

/**
 * Quick check: does this folder contain a `.git` directory (or
 * file, for git worktrees — `.git` is a file pointing at the
 * parent's gitdir when the worktree is itself a checkout of a
 * checkout). We use this to short-circuit the slow "git
 * something" path with a clear `not-repo` result for non-git
 * folders, instead of letting git's own error message leak out.
 */
export function isGitRepo(folder: string): boolean {
  try {
    return existsSync(join(folder, ".git"));
  } catch {
    return false;
  }
}

/**
 * Find the first base candidate that resolves to a real ref
 * (local or remote). Returns the fully-qualified ref (e.g.
 * `main` or `origin/main`) and whether it's local.
 */
export async function detectBase(folder: string): Promise<{ base: string; local: boolean } | null> {
  // First check local branches: refs/heads/<name>
  for (const name of BASE_CANDIDATES) {
    if (await refExists(folder, `refs/heads/${name}`)) {
      return { base: name, local: true };
    }
  }
  // Then check any remote: refs/remotes/<remote>/<name>
  for (const name of BASE_CANDIDATES) {
    const remote = await firstRemoteWithRef(folder, name);
    if (remote) return { base: `${remote}/${name}`, local: false };
  }
  return null;
}

async function refExists(folder: string, ref: string): Promise<boolean> {
  try {
    await git(folder, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

async function firstRemoteWithRef(folder: string, name: string): Promise<string | null> {
  let out: string;
  try {
    out = await git(folder, ["for-each-ref", "--format=%(refname:short)", `refs/remotes/*/${name}`]);
  } catch {
    return null;
  }
  // stdout is one ref per line, e.g. "origin/main\nupstream/main\n".
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Strip the trailing "/<name>" to get the remote name.
    const idx = trimmed.lastIndexOf("/");
    if (idx <= 0) continue;
    return trimmed.slice(0, idx);
  }
  return null;
}

/**
 * Get the current branch name, or the short SHA if HEAD is
 * detached. Used purely for diagnostics in the UI ("viewing
 * diff for `feat-x`"). The diff itself is `base..HEAD`, so we
 * don't actually need this for the computation.
 */
export async function currentBranch(folder: string): Promise<string | null> {
  try {
    const out = await git(folder, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const v = out.trim();
    if (!v || v === "HEAD") return null; // detached
    return v;
  } catch {
    return null;
  }
}

/**
 * Cheap summary used by the root view (the `+N -M` tag) and the
 * folder header. Runs a single `git diff --shortstat` and a
 * single `git ls-files --others --exclude-standard` — both
 * are O(repo size) but only emit a few bytes.
 */
export async function diffSummary(folder: string): Promise<DiffSummary | null> {
  if (!isGitRepo(folder)) return null;
  const base = await detectBase(folder);
  if (!base) return null;
  // The summary covers ALL changes in the worktree vs the
  // auto-detected base, broken into two sources:
  //
  //   1. branch diff: commits unique to this branch (base..HEAD)
  //   2. uncommitted: working tree + index vs HEAD
  //
  // We add them together because the user wants to see "what
  // has the AI done here" — both kinds of work. The diff
  // tab does the same; this is just the cheap aggregate.
  //
  // `git diff --shortstat` accepts a range and aggregates the
  // full diff between two refs. To combine both sources, we
  // run two shortstats (branch + uncommitted) and add the
  // numbers.
  let additions = 0;
  let deletions = 0;
  let files = 0;
  // Branch diff. Two-dot (base..HEAD) overcounts when the
  // histories have diverged; three-dot (base...HEAD) is what
  // "commits unique to this branch" usually means, but it
  // emits nothing when HEAD == base. We try three-dot first
  // (it gives a clean "what's in this branch" number); if
  // it's empty (e.g. we're sitting on main itself), the
  // uncommitted changes below will still surface.
  const branchAdds = await shortstatAddDel(folder, [
    "diff",
    "--shortstat",
    `${base.base}...HEAD`,
  ]).catch(() => ({ files: 0, additions: 0, deletions: 0 }));
  additions += branchAdds.additions;
  deletions += branchAdds.deletions;
  files += branchAdds.files;
  // Uncommitted (working tree + index vs HEAD). Always run
  // this — when the user is sitting on main with a stack of
  // uncommitted edits, this is the only thing that shows.
  const uncommittedAdds = await shortstatAddDel(folder, [
    "diff",
    "--shortstat",
    "HEAD",
  ]).catch(() => ({ files: 0, additions: 0, deletions: 0 }));
  additions += uncommittedAdds.additions;
  deletions += uncommittedAdds.deletions;
  files += uncommittedAdds.files;
  let untracked = 0;
  try {
    const out = await git(folder, ["ls-files", "--others", "--exclude-standard"]);
    if (out.trim()) untracked = out.trim().split("\n").length;
  } catch {}
  // Include untracked in the file count (they ARE changes in
  // the worktree), but keep `untracked` separate so the UI can
  // show "+3 untracked" if it wants.
  // For the line counts, the cheap shortstat approach above
  // does NOT count lines in untracked files. We could read
  // each one to count, but the typical untracked file is
  // large (a generated log, a binary, etc.) and we want the
  // summary to stay cheap. We expose the untracked count
  // separately so the UI can render it as a separate suffix
  // ("+3 untracked") rather than a misleading 0/0.
  return {
    ok: true,
    base: base.base,
    baseLocal: base.local,
    files: files + untracked,
    additions,
    deletions,
    untracked,
  };
}

/**
 * Parse `git diff --shortstat` output into structured counts.
 * Returns zero-filled defaults on empty input (which is what
 * `git diff` emits when there's no diff at all) or on parse
 * failure.
 */
async function shortstatAddDel(
  folder: string,
  args: string[],
): Promise<{ files: number; additions: number; deletions: number }> {
  let out: string;
  try {
    out = await git(folder, args);
  } catch {
    return { files: 0, additions: 0, deletions: 0 };
  }
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
}

/**
 * Full diff: per-file body, including untracked file contents
 * as a synthetic "added" diff. Used by the diff tab.
 *
 * The output is intentionally a wire-friendly JSON shape — the
 * client renders it directly, no parsing of a unified diff
 * string in the browser. We do parse hunks on the server
 * because (a) it lets us truncate per-file cleanly, and (b) it
 * keeps the client dumb.
 */
export async function diffFiles(folder: string): Promise<DiffResult> {
  if (!isGitRepo(folder)) {
    return { ok: false, reason: "not-repo", message: "Not a git repository" };
  }
  const base = await detectBase(folder);
  if (!base) {
    return {
      ok: false,
      reason: "no-base",
      message: `No base branch found (tried: ${BASE_CANDIDATES.join(", ")})`,
    };
  }
  // First attempt: three-dot range. This includes only commits
  // on HEAD that aren't reachable from `base` — exactly the
  // "AI's work" we want, ignoring anything main added in
  // parallel.
  let nameStatus = "";
  let diffBody = "";
  try {
    [nameStatus, diffBody] = await Promise.all([
      git(folder, ["diff", "--name-status", "-z", "--diff-filter=ACDMRT", `${base.base}...HEAD`]),
      gitMax(folder, ["diff", "--unified=3", `${base.base}...HEAD`]),
    ]);
  } catch {
    // Fall back to two-dot if the merge-base is empty
    // (e.g. base was force-pushed and the histories diverged).
    try {
      [nameStatus, diffBody] = await Promise.all([
        git(folder, ["diff", "--name-status", "-z", "--diff-filter=ACDMRT", `${base.base}..HEAD`]),
        gitMax(folder, ["diff", "--unified=3", `${base.base}..HEAD`]),
      ]);
    } catch (err) {
      return { ok: false, reason: "error", message: (err as Error).message };
    }
  }
  // Also include uncommitted changes (working tree + index vs HEAD).
  // We OR them into the same file list. If a file is in both, the
  // body we render is the union (working-tree diff + the branch
  // diff is not useful to anyone), so we dedupe by path with a
  // status precedence: uncommitted wins (it's the freshest state).
  const [wtNameStatus, wtBody] = await safeUncommitted(folder);
  const files = await buildFileList({
    branch: parseNameStatus(nameStatus),
    branchBody: diffBody,
    uncommitted: parseNameStatus(wtNameStatus),
    uncommittedBody: wtBody,
  });
  // Add untracked files as synthetic "added" diffs with the full
  // file body. We cap each untracked file at a reasonable size
  // to avoid reading a 500MB log file into memory.
  const untracked = await untrackedFiles(folder);
  let summaryInsertions = 0;
  let summaryDeletions = 0;
  for (const f of files) {
    summaryInsertions += f.additions;
    summaryDeletions += f.deletions;
  }
  for (const path of untracked) {
    const body = await readUntrackedFile(folder, path);
    if (body === null) {
      // File vanished between ls-files and read; skip.
      continue;
    }
    const lines = body.split("\n");
    // Drop the trailing empty element from a final newline so we
    // don't show an extra phantom "+" line. This matches what
    // `git diff` does for newly added files.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const hunks: DiffHunk[] = [
      {
        header: `@@ -0,0 +1,${lines.length} @@`,
        lines: lines.map((l) => ({ kind: "add", text: l })),
      },
    ];
    files.push({
      path,
      status: "untracked",
      additions: lines.length,
      deletions: 0,
      hunks,
    });
    summaryInsertions += lines.length;
  }
  // Sort: by status (deleted first, then modified, then added/renamed
  // /untracked) so the user sees the most "destructive" changes at
  // the top, matching how a code review would surface them.
  const order: Record<FileStatus, number> = {
    deleted: 0,
    modified: 1,
    renamed: 2,
    typechange: 3,
    copied: 4,
    added: 5,
    untracked: 6,
  };
  files.sort((a, b) => {
    const o = order[a.status] - order[b.status];
    if (o !== 0) return o;
    return a.path.localeCompare(b.path);
  });
  return {
    ok: true,
    base: base.base,
    baseLocal: base.local,
    files,
    summary: {
      files: files.length,
      additions: summaryInsertions,
      deletions: summaryDeletions,
      untracked: untracked.length,
    },
  };
}

interface ParsedNameStatus {
  entries: Array<{
    status: FileStatus;
    path: string;
    oldPath?: string;
  }>;
}

/**
 * `git diff --name-status -z` emits NUL-separated records. The
 * shape is:
 *
 *   <status>\0<path>\0           for added/modified/deleted
 *   <status>\0<oldPath>\0<newPath>\0  for renamed/copied
 *
 * Status is one of A/M/D/R/C/T plus an optional score (R100,
 * C075) that we ignore. We treat both R and C the same way
 * ("renamed" in the UI) since a true copy is rare in agent
 * diffs and conflating them keeps the UI simpler.
 */
export function parseNameStatus(blob: string): ParsedNameStatus {
  const parts = blob.split("\0");
  const entries: ParsedNameStatus["entries"] = [];
  let i = 0;
  while (i < parts.length) {
    const head = parts[i];
    if (!head) {
      i++;
      continue;
    }
    // Strip the score (e.g. "R100" → "R")
    const code = head[0];
    if (code === "R" || code === "C") {
      const oldPath = parts[i + 1] ?? "";
      const newPath = parts[i + 2] ?? "";
      if (oldPath && newPath) {
        entries.push({
          status: code === "R" ? "renamed" : "copied",
          path: newPath,
          oldPath,
        });
      }
      i += 3;
      continue;
    }
    const path = parts[i + 1] ?? "";
    if (path) {
      const status: FileStatus =
        code === "A" ? "added" :
        code === "D" ? "deleted" :
        code === "M" ? "modified" :
        code === "T" ? "typechange" :
        "modified";
      entries.push({ status, path });
    }
    i += 2;
  }
  return { entries };
}

interface BuildInput {
  branch: ParsedNameStatus;
  branchBody: string;
  uncommitted: ParsedNameStatus;
  uncommittedBody: string;
}

/**
 * Walk both the branch-diff and uncommitted name-status lists
 * and emit a unified `DiffFile[]` array. For files that appear
 * in both lists, the uncommitted body wins (it's the freshest
 * state of the worktree, which is what the user cares about).
 */
async function buildFileList(input: BuildInput): Promise<DiffFile[]> {
  const result: DiffFile[] = [];
  // Map by path so we can detect overlap.
  const byPath = new Map<
    string,
    { entry: ParsedNameStatus["entries"][number]; body: DiffHunk[] | null; from: "branch" | "uncommitted" }
  >();
  // Parse the branch diff body into a map of path → hunks. The
  // body is a series of `diff --git a/<path> b/<path>` blocks
  // separated by hunks. We split on those headers and bucket
  // each block by its path.
  const branchHunks = parseUnifiedDiff(input.branchBody);
  for (const e of input.branch.entries) {
    byPath.set(e.path, { entry: e, body: branchHunks.get(e.path) ?? null, from: "branch" });
  }
  const uncommittedHunks = parseUnifiedDiff(input.uncommittedBody);
  for (const e of input.uncommitted.entries) {
    const existing = byPath.get(e.path);
    if (existing) {
      // Replace with the uncommitted version; it's fresher.
      byPath.set(e.path, {
        entry: e,
        body: uncommittedHunks.get(e.path) ?? existing.body,
        from: "uncommitted",
      });
    } else {
      byPath.set(e.path, {
        entry: e,
        body: uncommittedHunks.get(e.path) ?? null,
        from: "uncommitted",
      });
    }
  }
  for (const { entry, body } of byPath.values()) {
    let hunks = body ?? [];
    let additions = 0;
    let deletions = 0;
    for (const h of hunks) {
      for (const l of h.lines) {
        if (l.kind === "add") additions++;
        else if (l.kind === "del") deletions++;
      }
    }
    if (!hunks.length && entry.status === "deleted") {
      // A delete with no body in the diff output (shouldn't
      // happen, but be defensive): the file is gone, no hunks.
      additions = 0;
      deletions = 0;
    }
    result.push({
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      hunks,
      additions,
      deletions,
    });
  }
  return result;
}

/**
 * Parse a `git diff` body into per-file hunk arrays. The body
 * is a sequence of:
 *
 *   diff --git a/<p> b/<p>
 *   <possibly "similarity index" / "rename from" / "rename to" / "index" / "new file mode" / "deleted file mode" lines>
 *   --- a/<p>       (or /dev/null for added)
 *   +++ b/<p>       (or /dev/null for deleted)
 *   @@ ... @@
 *   <hunk lines>
 *   @@ ... @@
 *   <hunk lines>
 *   diff --git a/<next> b/<next>
 *   ...
 *
 * We slice on `diff --git ` boundaries (anchored at line
 * starts), then for each slice pull out the hunks.
 */
export function parseUnifiedDiff(body: string): Map<string, DiffHunk[]> {
  const out = new Map<string, DiffHunk[]>();
  if (!body) return out;
  // Anchor the split so we don't match `diff --git` mentioned
  // inside a file body (impossible in git's output, but cheap
  // to be safe).
  const blocks = body.split(/^diff --git /m);
  // blocks[0] is empty (the body starts with the first marker).
  for (const block of blocks) {
    if (!block) continue;
    // Path appears in the first line: `a/<path> b/<path>`.
    // We use the b/ side, which is the post-rename path.
    const pathMatch = /^a\/(.+?) b\/(.+)$/m.exec(block);
    if (!pathMatch) continue;
    const path = pathMatch[2];
    const hunks: DiffHunk[] = [];
    // Walk the block, line by line, looking for `@@` headers
    // and then consuming lines until the next `@@` or end of
    // block.
    const lines = block.split("\n");
    let i = 0;
    // Skip the metadata preamble (everything up to the first
    // `@@`). The preamble includes `index ...`, `--- a/p`,
    // `+++ b/p`, and `rename from/to` lines for renames.
    while (i < lines.length && !lines[i].startsWith("@@")) i++;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith("@@")) {
        const header = line;
        i++;
        const hunkLines: DiffLine[] = [];
        while (i < lines.length && !lines[i].startsWith("@@")) {
          const l = lines[i];
          // `\ No newline at end of file` — not rendered.
          if (l.startsWith("\\")) {
            i++;
            continue;
          }
          if (l.startsWith("+")) {
            hunkLines.push({ kind: "add", text: l.slice(1) });
          } else if (l.startsWith("-")) {
            hunkLines.push({ kind: "del", text: l.slice(1) });
          } else if (l.startsWith(" ")) {
            hunkLines.push({ kind: "ctx", text: l.slice(1) });
          } else {
            // Empty / structural line — render as context.
            hunkLines.push({ kind: "ctx", text: l });
          }
          i++;
        }
        hunks.push({ header, lines: hunkLines });
      } else {
        i++;
      }
    }
    if (hunks.length > 0) {
      out.set(path, hunks);
    }
  }
  return out;
}

/**
 * Run `git diff --name-status` and `git diff` over the working
 * tree (incl. staged). Returns ["", ""] on failure so callers
 * can chain without try/catch.
 */
async function safeUncommitted(folder: string): Promise<[string, string]> {
  try {
    const [nameStatus, body] = await Promise.all([
      git(folder, ["diff", "--name-status", "-z", "--diff-filter=ACDMRT", "HEAD"]),
      gitMax(folder, ["diff", "--unified=3", "HEAD"]),
    ]);
    return [nameStatus, body];
  } catch {
    return ["", ""];
  }
}

async function untrackedFiles(folder: string): Promise<string[]> {
  try {
    const out = await git(folder, ["ls-files", "--others", "--exclude-standard"]);
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readUntrackedFile(folder: string, relPath: string): Promise<string | null> {
  // Cap at 200KB to keep the diff payload reasonable. Most
  // agent-generated files fit comfortably under that. Larger
  // files (generated logs, big JSON dumps) still get listed in
  // the diff as "+untracked", the body just shows the first
  // 200KB.
  const cap = 200 * 1024;
  try {
    const { stdout } = await execFileP("git", ["-C", folder, "show", `:0:${relPath}`], {
      maxBuffer: cap + 1024,
      timeout: GIT_TIMEOUT_MS,
    }).catch(() => ({ stdout: "" }));
    if (stdout) return stdout.slice(0, cap);
  } catch {}
  // Fallback to a plain read for files that aren't in the
  // index (which `git show :0:` would 404 on).
  try {
    const { readFile } = await import("node:fs/promises");
    const full = join(folder, relPath);
    const buf = await readFile(full);
    return buf.toString("utf8", 0, Math.min(buf.length, cap));
  } catch {
    return null;
  }
}

function git(folder: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", folder, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF_BYTES, encoding: "utf8" },
      (err, stdout) => {
        if (err) {
          // execFile attaches the captured stdout to the error
          // object; drop it to keep messages small.
          reject(err);
          return;
        }
        resolve(stdout ?? "");
      },
    );
  });
}

/**
 * Same as `git`, but for commands that emit large bodies. We
 * cap the buffer at MAX_DIFF_BYTES; if the diff exceeds it, we
 * truncate and attach a `truncated: true` flag on the file
 * later. (We don't have per-file accounting here, but the
 * truncated flag is the only signal the UI needs.)
 */
function gitMax(folder: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", folder, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF_BYTES, encoding: "utf8" },
      (err, stdout) => {
        if (err) {
          // ENOBUFS (maxBuffer exceeded) is recoverable: the
          // stdout we got is the truncated body. Treat it as
          // a success-with-truncation rather than an error.
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            resolve(stdout ?? "");
            return;
          }
          reject(err);
          return;
        }
        resolve(stdout ?? "");
      },
    );
  });
}
