/**
 * Cheap subsequence fuzzy matching for file paths — every char of
 * the query must appear in order in the path. Scoring prefers
 * basename matches, then earlier first hits, then shorter paths.
 *
 * Shared by the composer's @-picker and the Files tab's search so
 * both rank identically.
 */

export function fuzzyScore(path: string, q: string): number | null {
  const lower = path.toLowerCase();
  let qi = 0;
  let firstHit = -1;
  for (let pi = 0; pi < lower.length && qi < q.length; pi++) {
    if (lower[pi] === q[qi]) {
      if (firstHit === -1) firstHit = pi;
      qi++;
    }
  }
  if (qi !== q.length) return null;
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const baseHit = base.includes(q) ? 100 : 0;
  return baseHit - firstHit - path.length;
}

/** Fuzzy-filter + rank a file list; capped at `limit`. */
export function fuzzyFiles(
  files: string[],
  q: string,
  limit: number,
): string[] {
  const query = q.toLowerCase();
  if (!query) return files.slice(0, limit);
  const out: Array<{ path: string; score: number }> = [];
  for (const p of files) {
    const s = fuzzyScore(p, query);
    if (s !== null) out.push({ path: p, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.map((x) => x.path).slice(0, limit);
}