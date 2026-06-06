/**
 * A small line-level LCS diff used for the inline chat edit
 * previews. The diff is computed client-side at render time
 * (the body of a tool-call diff block can be a few hundred
 * lines at most, so the O(n*m) DP is fine).
 *
 * The full worktree diff (the diff tab) goes through git on
 * the server; this one is purely for the chat tool output.
 */

export type InlineDiffLine = { kind: "ctx" | "add" | "del"; text: string };

export function buildInlineDiff(oldText: string, newText: string): InlineDiffLine[] {
  // split("\n") treats a trailing newline as a final empty
  // line, and an empty input as a single empty line. We
  // normalise both to "no lines" / "lines plus optional
  // trailing empty" so the diff matches what a user reading
  // the file would see: an empty file is zero lines, not one
  // empty line.
  const splitLines = (s: string): string[] => {
    if (s === "") return [];
    const parts = s.split("\n");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  };
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;
  // dp[i][j] = length of the longest common suffix of a[i..]
  // and b[j..]. Computed bottom-up so we can backtrack the
  // diff in a single pass.
  const dp: number[][] = Array.from(
    { length: n + 1 },
    () => new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: InlineDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}
