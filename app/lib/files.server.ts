import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

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

// -----------------------------------------------------------------------
// File content (read-only, for the Files tab)
// -----------------------------------------------------------------------

/** Files above this are still listed but not previewed. */
const MAX_CONTENT_BYTES = 1024 * 1024;
/** Binary sniff window — a null byte or invalid UTF-8 here means
 * the file won't render as text. */
const SNIFF_BYTES = 8192;

export interface FileContent {
  /** Decoded text; absent for binary/too-large files. */
  content?: string;
  /** Byte size (always present). */
  size: number;
  /** True when the bytes look like text but exceed the cap. */
  tooLarge?: boolean;
  /** True when the bytes are not renderable text. */
  binary?: boolean;
}

/** Extensions we preview as markdown rather than raw code. */
const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdx"]);

/** Extensions safe to serve raw for <img> preview. Raster only —
 * SVG stays code/text (it can embed scripts). */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export function isMarkdown(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MARKDOWN_EXT.has(ext);
}

export function imageMime(path: string): string | null {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return IMAGE_MIME[ext] ?? null;
}

/**
 * Read one file inside `folder` for preview. `relPath` must stay
 * inside the folder after resolution — traversal attempts ("..",
 * absolute paths, symlink escapes via realpath) return null. The
 * result is capped: binaries and files over 1 MiB are described,
 * not delivered.
 */
export async function readFileContent(
  folder: string,
  relPath: string,
): Promise<FileContent | null> {
  if (!relPath || relPath.includes("\0")) return null;
  // Resolve both sides against the filesystem (realpath follows
  // symlinks) and require the file to stay inside the folder.
  let root: string;
  let full: string;
  try {
    root = await realpath(folder);
    full = await realpath(join(folder, relPath));
  } catch {
    return null; // missing file or a broken symlink
  }
  const inside = relative(root, full);
  if (!inside || inside.startsWith("..") || inside === "") return null;
  if (resolve(full) === resolve(root)) return null;

  let s;
  try {
    s = await stat(full);
  } catch {
    return null;
  }
  if (!s.isFile()) return null;

  if (s.size > MAX_CONTENT_BYTES) {
    return { size: s.size, tooLarge: true };
  }

  const buf = await readFile(full); // ≤1 MiB, safe to slurp
  const sniff = buf.subarray(0, SNIFF_BYTES);
  if (sniff.includes(0)) {
    return { size: s.size, binary: true };
  }
  // Reject bytes that don't decode as UTF-8 (BOM-tolerant: the
  // decoder strips a leading BOM rather than failing on it).
  const cleaned = sniff[0] === 0xef && sniff[1] === 0xbb && sniff[2] === 0xbf
    ? sniff.subarray(3)
    : sniff;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(cleaned);
  } catch {
    return { size: s.size, binary: true };
  }
  return { size: s.size, content: buf.toString("utf8") };
}
