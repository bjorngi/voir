import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * Server-side file index for a registered folder. Walks the tree once
 * on demand (cached briefly) and returns a flat list of file paths
 * relative to the folder. Bounded — doesn't recurse into huge
 * dependency / VCS directories.
 *
 * This is intentionally a plain text endpoint, not a streaming
 * directory watcher: the browser fuzzy-matches in-memory.
 */

const MAX_FILES = 5000;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "coverage",
  "out",
  "target",    // rust/java
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  "Pods",      // cocoapods
]);

const SKIP_FILES = new Set([
  // Lockfiles & generated noise that nobody @-mentions
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "composer.lock",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "go.sum",
]);

interface CacheEntry {
  at: number;
  files: string[];
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

export async function listFiles(folder: string): Promise<string[]> {
  const hit = cache.get(folder);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.files;

  const files: string[] = [];
  const root = folder.endsWith(sep) ? folder : folder + sep;

  async function walk(dir: string) {
    if (files.length >= MAX_FILES) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return; // permission denied, etc.
    }
    for (const name of names) {
      if (files.length >= MAX_FILES) return;
      // Hidden directories we always skip; otherwise allow .dotfiles
      // but skip the well-known heavy ones.
      if (name.startsWith(".")) {
        if (name === ".git" || name === ".hg" || name === ".svn") continue;
      }
      const full = join(dir, name);
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        await walk(full);
      } else if (s.isFile()) {
        if (SKIP_FILES.has(name)) continue;
        const rel = relative(root, full);
        files.push(rel);
      }
    }
  }

  // Verify the folder exists before walking
  try {
    const s = await stat(folder);
    if (!s.isDirectory()) {
      cache.set(folder, { at: Date.now(), files: [] });
      return [];
    }
  } catch {
    cache.set(folder, { at: Date.now(), files: [] });
    return [];
  }

  await walk(folder);
  files.sort();
  cache.set(folder, { at: Date.now(), files });
  return files;
}

export function invalidateFiles(folder: string) {
  cache.delete(folder);
}
