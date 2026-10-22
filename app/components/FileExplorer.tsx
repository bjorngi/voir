/**
 * Read-only file explorer for a registered folder — the "Files"
 * tab next to Chat and Changes.
 *
 * Two states, driven by the `?file=<relpath>` query param (kept in
 * the URL via pushState so the phone back button closes a file —
 * no server roundtrip per tap):
 *
 *   tree    → the folder's file index (the same flat, cached list
 *             the @-mention picker uses), rendered as a
 *             collapsible tree: directories first, then files.
 *   viewer  → one file, read-only. Markdown files render, raster
 *             images preview, code/text streams in a mono block.
 *             "Attach to chat" seeds the file as an @-mention in
 *             the conversation the tab bar returns to (or the
 *             folder's newest session).
 *
 * No editing: the agent is the writer, voir is the reader.
 */
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "~/components/CodeBlock";
import { fuzzyFiles } from "~/lib/fuzzy";
import { sessionUrl } from "~/lib/urls";
import type { ChatLoaderData } from "~/routes/chat";
import type { FileContent } from "~/lib/files.server";

type FilesData = Extract<ChatLoaderData, { k: "files" }>;

// -- tree ----------------------------------------------------------------

type Entry =
  | { kind: "dir"; name: string; path: string; children: Entry[] }
  | { kind: "file"; name: string; path: string };

/** Flat sorted relpaths → nested tree, directories before files.
 * Build pass keeps directories as maps (cheap incremental
 * insertion); the materialize pass converts to sorted arrays
 * with directories first, files interleaved alphabetically. */
type MDir = {
  kind: "dir";
  name: string;
  path: string;
  children: Map<string, MEntry>;
};
type MFile = { kind: "file"; name: string; path: string };
type MEntry = MDir | MFile;

function buildTree(files: string[]): Entry[] {
  const root = new Map<string, MEntry>();
  for (const rel of files) {
    const parts = rel.split("/");
    let level = root;
    let prefix = "";
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      prefix = prefix ? `${prefix}/${name}` : name;
      if (i === parts.length - 1) {
        level.set(name, { kind: "file", name, path: prefix });
      } else {
        let dir = level.get(name);
        if (!dir || dir.kind === "file") {
          dir = { kind: "dir", name, path: prefix, children: new Map() };
          level.set(name, dir);
        }
        level = dir.children;
      }
    }
  }
  const materialize = (m: Map<string, MEntry>): Entry[] =>
    [...m.values()]
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((e) =>
        e.kind === "dir"
          ? {
              kind: "dir" as const,
              name: e.name,
              path: e.path,
              children: materialize(e.children),
            }
          : { kind: "file" as const, name: e.name, path: e.path },
      );
  return materialize(root);
}

// -- preview classification ----------------------------------------------

const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

function isMarkdown(p: string) {
  return MARKDOWN_EXT.test(p);
}
function isImage(p: string) {
  return IMAGE_EXT.test(p);
}
function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// -- component ------------------------------------------------------------

export function FileExplorer({ data }: { data: FilesData }) {
  const { folder, files, fromSessionId } = data;
  const tree = useMemo(() => buildTree(files), [files]);

  // Selected file comes from ?file= (deep-linkable); taps
  // pushState so the back button feels native.
  const [selected, setSelected] = useState<string | null>(() => {
    if (typeof document === "undefined") return null;
    return new URLSearchParams(window.location.search).get("file");
  });
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const sel = new URLSearchParams(
      typeof document === "undefined" ? "" : window.location.search,
    ).get("file");
    // Start with the selected file's ancestors open.
    const s = new Set<string>();
    if (sel) {
      const parts = sel.split("/");
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join("/"));
    }
    return s;
  });

  useEffect(() => {
    const onPop = () => {
      const f = new URLSearchParams(window.location.search).get("file");
      setSelected(f);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Deep-linked ?file= pointing at a *directory* (e.g. the chip of
  // an attached folder): there is no file to view — expand the
  // folder (and its ancestors) in the tree instead, then clear the
  // param so the back button behaves.
  useEffect(() => {
    if (!selected || files.includes(selected)) return;
    const isDir = files.some((f) => f.startsWith(selected + "/"));
    if (!isDir) return;
    setExpanded((s) => {
      const next = new Set(s);
      const parts = selected.split("/");
      for (let i = 1; i <= parts.length; i++) {
        next.add(parts.slice(0, i).join("/"));
      }
      return next;
    });
    setSelected(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("file");
    history.replaceState({}, "", url);
  }, [selected, files]);

  function openFile(path: string) {
    setSelected(path);
    const url = new URL(window.location.href);
    url.searchParams.set("file", path);
    history.pushState({ voirFile: true }, "", url);
  }

  function closeFile() {
    if (history.state?.voirFile) {
      history.back();
    } else {
      // Deep-linked straight into a file: no tree state behind us.
      const url = new URL(window.location.href);
      url.searchParams.delete("file");
      history.replaceState({}, "", url);
      setSelected(null);
    }
  }

  // Attach target: the session the tab bar preserves, else the
  // folder's newest session. None → the attach affordance hides.
  const attachSessionId =
    fromSessionId ?? (folder.sessions[0]?.id ?? null);
  const attachUrl = (relpath: string): string | null =>
    attachSessionId
      ? `${sessionUrl(folder.path, attachSessionId)}?attach=${encodeURIComponent(relpath)}`
      : null;

  // Fuzzy search over the flat index (same scorer as the
  // composer's @-picker). Non-empty query replaces the tree with
  // a ranked flat list — search is about jumping, not browsing.
  const [query, setQuery] = useState("");
  const results = useMemo(
    () => (query.trim() ? fuzzyFiles(files, query.trim(), 100) : null),
    [files, query],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {selected ? (
        <FileViewer
          key={selected}
          folder={folder.path}
          path={selected}
          size={files.length}
          attachHref={attachUrl(selected)}
          onBack={closeFile}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-neutral-900 bg-neutral-950 px-3 py-2">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-neutral-600"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search files…"
              aria-label="Search files"
              className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="shrink-0 text-neutral-600 active:text-neutral-300"
              >
                ×
              </button>
            )}
          </div>
          <p className="px-4 pb-2 pt-3 font-mono text-[10px] uppercase tracking-widest text-neutral-600">
            {results !== null
              ? `${results.length} match${results.length === 1 ? "" : "es"}`
              : `${files.length} file${files.length === 1 ? "" : "s"} · read-only`}
          </p>
          {results !== null ? (
            <ul>
              {results.map((p) => (
                <li key={p} className="relative">
                  <button
                    type="button"
                    onClick={() => openFile(p)}
                    className="flex w-full items-baseline gap-3 py-2.5 pl-4 pr-12 text-left active:bg-neutral-900"
                  >
                    <span className="min-w-0 shrink-0 truncate font-mono text-[12px] text-neutral-200">
                      {p.slice(p.lastIndexOf("/") + 1)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-500">
                      {p.slice(0, p.lastIndexOf("/") + 1) || "/"}
                    </span>
                  </button>
                  <RowAttach href={attachUrl(p)} relpath={p} />
                </li>
              ))}
              {results.length === 0 && (
                <li className="px-4 py-6 text-center text-sm text-neutral-600">
                  No files match “{query.trim()}”.
                </li>
              )}
            </ul>
          ) : (
            <ul>
              {tree.map((e) => (
                <li key={e.path}>
                  <TreeRow
                    entry={e}
                    depth={0}
                    expanded={expanded}
                    attachUrl={attachUrl}
                    onToggle={(p) =>
                      setExpanded((s) => {
                        const next = new Set(s);
                        if (next.has(p)) next.delete(p);
                        else next.add(p);
                        return next;
                      })
                    }
                    onOpen={openFile}
                  />
                </li>
              ))}
            </ul>
          )}
          {files.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-neutral-600">
              No files found in this folder.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The attach (paperclip) affordance for tree/search rows — a
 * sibling overlay so taps never leak into the row button. */
function RowAttach({ href, relpath }: { href: string | null; relpath: string }) {
  if (!href) return null;
  return (
    <a
      href={href}
      title={`Attach ${relpath} to the chat`}
      aria-label={`Attach ${relpath} to the chat`}
      className="absolute right-1 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded text-neutral-600 active:bg-neutral-900 active:text-amber-300"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
      </svg>
    </a>
  );
}

// -- tree rows ------------------------------------------------------------

function TreeRow({
  entry,
  depth,
  expanded,
  attachUrl,
  onToggle,
  onOpen,
}: {
  entry: Entry;
  depth: number;
  expanded: Set<string>;
  /** Builds the attach-to-chat URL for a path; null hides the
   * paperclip (no session to attach into). */
  attachUrl: (path: string) => string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  if (entry.kind === "dir") {
    const open = expanded.has(entry.path);
    const count = entry.children.length;
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => onToggle(entry.path)}
          className="flex w-full items-center gap-2 py-2.5 pr-10 pl-3 text-left active:bg-neutral-900"
          style={{ paddingLeft: 12 + depth * 16 }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={
              "shrink-0 text-neutral-600 transition-transform " +
              (open ? "rotate-90" : "")
            }
            aria-hidden="true"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-200">
            {entry.name}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-neutral-600">
            {count}
          </span>
        </button>
        {/* Folders attach too: the dir's path becomes the resource
         * link target (agents can list/read it). */}
        <RowAttach href={attachUrl(entry.path)} relpath={entry.path} />
        {open && (
          <ul>
            {entry.children.map((c) => (
              <li key={c.path}>
                <TreeRow
                  entry={c}
                  depth={depth + 1}
                  expanded={expanded}
                  attachUrl={attachUrl}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onOpen(entry.path)}
        className="flex w-full items-center gap-2 py-2.5 pr-10 text-left active:bg-neutral-900"
        style={{ paddingLeft: 12 + depth * 16 + 20 }}
      >
        {/* file dot, aligned under the dir chevrons */}
        <span className="h-1 w-1 shrink-0 rounded-full bg-neutral-700" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-neutral-300">
          {entry.name}
        </span>
      </button>
      <RowAttach href={attachUrl(entry.path)} relpath={entry.path} />
    </div>
  );
}

// -- file viewer ----------------------------------------------------------

function FileViewer({
  folder,
  path,
  attachHref,
  onBack,
}: {
  folder: string;
  path: string;
  size: number;
  attachHref: string | null;
  onBack: () => void;
}) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setContent(null);
    setError(null);
    fetch(
      `/api/folder-file?folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(path)}`,
    )
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Not found");
        return r.json() as Promise<FileContent>;
      })
      .then((c) => alive && setContent(c))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [folder, path]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to file list"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded text-neutral-400 active:bg-neutral-900"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12px] text-neutral-300"
          title={path}
        >
          {path}
        </span>
        {attachHref && (
          <a
            href={attachHref}
            title="Attach this file to the chat as an @-mention"
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded px-2 text-[11px] font-mono uppercase tracking-wider text-amber-300 active:bg-neutral-900"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            Attach
          </a>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {error && (
          <p className="py-6 text-center text-sm text-rose-400">{error}</p>
        )}
        {!error && !content && (
          <p className="py-6 text-center font-mono text-xs text-neutral-600">
            loading…
          </p>
        )}
        {content && <FileBody path={path} folder={folder} content={content} />}
      </div>
    </div>
  );
}

function FileBody({
  path,
  folder,
  content,
}: {
  path: string;
  folder: string;
  content: FileContent;
}) {
  if (content.tooLarge) {
    return (
      <Notice>
        This file is {prettySize(content.size)} — too large to preview.
        Attach it instead and let the agent read it.
      </Notice>
    );
  }
  if (isImage(path)) {
    const src = `/api/folder-file?raw=1&folder=${encodeURIComponent(folder)}&file=${encodeURIComponent(path)}`;
    return (
      <img
        src={src}
        alt={path}
        className="mx-auto max-h-[70vh] max-w-full rounded border border-neutral-800"
      />
    );
  }
  if (!content.content) {
    // Binary (and not a previewable image)
    return (
      <Notice>
        Binary file ({prettySize(content.size ?? 0)}). Attach it and let the
        agent inspect it.
      </Notice>
    );
  }
  if (isMarkdown(path)) {
    return (
      <div className="text-[13px] leading-relaxed text-neutral-200">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: (p) => <h1 className="mb-2 mt-4 text-lg font-bold" {...p} />,
            h2: (p) => <h2 className="mb-2 mt-4 text-base font-bold" {...p} />,
            h3: (p) => <h3 className="mb-1 mt-3 text-sm font-bold" {...p} />,
            p: (p) => <p className="my-2" {...p} />,
            ul: (p) => (
              <ul className="my-2 list-disc pl-5" {...p} />
            ),
            ol: (p) => (
              <ol className="my-2 list-decimal pl-5" {...p} />
            ),
            li: (p) => <li className="my-0.5" {...p} />,
            a: (p) => (
              <a className="text-sky-400 underline underline-offset-2" {...p} />
            ),
            code: ({ node, className, children, ...rest }) => {
              const m = /language-([\w-]+)/.exec(className ?? "");
              if (m) {
                return (
                  <CodeBlock
                    code={String(children)}
                    language={m[1]}
                    maxHeightClass="max-h-[50vh]"
                  />
                );
              }
              return (
                <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-amber-200" {...rest}>
                  {children}
                </code>
              );
            },
            pre: (p) => <pre className="my-2" {...p} />,
            blockquote: (p) => (
              <blockquote
                className="my-2 border-l-2 border-neutral-700 pl-3 text-neutral-400"
                {...p}
              />
            ),
            table: (p) => (
              <div className="my-2 overflow-x-auto">
                <table className="w-full border-collapse text-[12px]" {...p} />
              </div>
            ),
            th: (p) => (
              <th
                className="border border-neutral-800 bg-neutral-900 px-2 py-1 text-left"
                {...p}
              />
            ),
            td: (p) => (
              <td className="border border-neutral-800 px-2 py-1" {...p} />
            ),
            hr: () => <hr className="my-4 border-neutral-800" />,
          }}
        >
          {content.content}
        </ReactMarkdown>
      </div>
    );
  }
  // Plain code/text: same shower as the Changes view, plus
  // syntax highlighting and the wrap toggle.
  return <CodeBlock code={content.content} path={path} />;
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded border border-neutral-800 bg-neutral-900/50 px-4 py-6 text-center text-sm text-neutral-400">
      {children}
    </p>
  );
}