import { useEffect, useRef, useState } from "react";
import type { ActivityRow } from "~/lib/chat-types";
import { folderUrl } from "~/lib/urls";

/** One folder in the navigation index (/api/nav). */
type NavFolder = {
  path: string;
  agents: string[];
  sessions: {
    id: string;
    title: string | undefined;
    status: string | undefined;
    updatedAt: number;
    busy: boolean;
  }[];
};
import type { SearchHit, SearchSessionResult } from "~/lib/search.server";
import { shortPath } from "~/lib/format";
import { sessionUrl } from "~/lib/urls";
import { WorkingOnSection } from "./ActiveSessions";

/**
 * The hamburger menu panel — a full-screen overlay above the
 * current view. It opens and closes from the header's menu
 * button (same button, icon swaps to ✕); there is no close
 * affordance inside the panel itself.
 *
 * Two states:
 *
 *  - search box empty → the "Working on" shortlist as before
 *    (docs/session-status.md), the fast-switch surface.
 *  - typing → cross-session search (docs/search.md): debounced
 *    /api/search, results grouped by session with snippet
 *    highlights; a tap opens the chat and jumps to the first
 *    hit (?focus=). Title-only matches are marked as such.
 */

const SEARCH_DEBOUNCE_MS = 250;

export function Picker({
  active,
  onClose,
}: {
  active: ActivityRow[];
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchSessionResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Request generation: a keystroke aborts the in-flight fetch;
  // this token keeps the spinner honest so a stale response can't
  // clear it while the newest query is still running.
  const genRef = useRef(0);
  // Folder/session index for the empty-state list. Fetched once, when the
  // sheet opens: it is navigation data, and chat page loads must not pay
  // for it (the whole point of the sheet is that it is not on the hot path).
  const [nav, setNav] = useState<NavFolder[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/nav")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { folders: NavFolder[] }) => {
        if (alive) setNav(d.folders);
      })
      .catch(() => {
        if (alive) setNav([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      genRef.current++;
      setResults(null);
      setSearching(false);
      return;
    }
    const gen = ++genRef.current;
    const ctrl = new AbortController();
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`search failed: ${res.status}`);
        const data = (await res.json()) as { results: SearchSessionResult[] };
        if (gen !== genRef.current) return; // superseded mid-flight
        setResults(data.results);
      } catch (err) {
        if ((err as Error).name !== "AbortError" && gen === genRef.current) {
          setResults([]);
        }
      } finally {
        if (gen === genRef.current) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-neutral-950">
      <div className="flex h-full flex-col">
        <div className="flex h-12 shrink-0 items-center border-b border-neutral-800 px-3">
          <span className="text-sm text-neutral-200">Menu</span>
        </div>
        <div className="shrink-0 border-b border-neutral-800 px-3 py-2">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search conversations…"
            enterKeyHint="search"
            aria-label="Search conversations"
            className="w-full border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          />
        </div>
        {results === null ? (
          <div className="scrollbar-hide flex-1 overflow-y-auto pb-6">
            <WorkingOnSection
              rows={active}
              onPick={onClose}
              empty="Nothing active — star a chat to track it here."
            />
            {nav === null ? (
              <p className="px-4 py-3 font-mono text-[11px] text-neutral-600">
                Loading folders…
              </p>
            ) : nav.length === 0 ? (
              <p className="px-4 py-3 text-sm text-neutral-600">
                No folders registered. Start an agent with acp-spawn.
              </p>
            ) : (
              nav.map((f) => (
                <section key={f.path} className="border-t border-neutral-900">
                  <a
                    href={folderUrl(f.path)}
                    onClick={onClose}
                    className="flex items-baseline gap-2 px-4 pb-1 pt-3 active:bg-neutral-900"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-neutral-300">
                      {shortPath(f.path)}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-neutral-600">
                      {f.agents.join(" · ")}
                    </span>
                  </a>
                  {f.sessions.length === 0 ? (
                    <p className="px-4 pb-2 font-mono text-[11px] text-neutral-700">
                      no sessions
                    </p>
                  ) : (
                    f.sessions.map((s2) => (
                      <a
                        key={s2.id}
                        href={sessionUrl(f.path, s2.id)}
                        onClick={onClose}
                        className="block px-4 py-2 text-[13px] text-neutral-300 active:bg-neutral-900"
                      >
                        {s2.status === "archived" && (
                          <span className="mr-1.5 rounded border border-neutral-800 px-1 py-0.5 font-mono text-[9px] text-neutral-600">
                            archived
                          </span>
                        )}
                        {s2.status === "active" && (
                          <span
                            title="Active — in Working on"
                            className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-blue-400 align-middle"
                          />
                        )}
                        {s2.title ?? s2.id.slice(0, 8)}
                      </a>
                    ))
                  )}
                </section>
              ))
            )}
          </div>
        ) : (
          <div className="scrollbar-hide flex-1 overflow-y-auto">
            <div className="flex items-baseline justify-between px-4 pb-1 pt-3">
              <h2 className="text-xs font-medium tracking-wide text-neutral-500">
                {searching ? "Searching…" : `${results.length} conversation${results.length === 1 ? "" : "s"}`}
              </h2>
            </div>
            {results.length === 0 && !searching && (
              <p className="px-4 pb-4 text-sm text-neutral-600">
                No matches for “{q.trim()}”.
              </p>
            )}
            {results.map((r) => (
              <SearchResultRow key={r.sessionId} result={r} onPick={onClose} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One session group: title + folder chrome, message snippets
 *  beneath, deep-linking the chat to the first hit. */
function SearchResultRow({
  result,
  onPick,
}: {
  result: SearchSessionResult;
  onPick: () => void;
}) {
  const first = result.hits[0];
  const href =
    sessionUrl(result.folder, result.sessionId) +
    (first ? `?focus=${encodeURIComponent(first.id)}` : "");
  return (
    <a
      href={href}
      onClick={onPick}
      className="block border-b border-neutral-900 px-4 py-2.5 active:bg-neutral-900"
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-200">
          {result.title ?? result.sessionId.slice(0, 8)}
        </span>
        <span className="shrink-0 font-mono text-[10px] uppercase text-neutral-600">
          {shortPath(result.folder)}
        </span>
      </div>
      {result.hits.map((h) => (
        <HitSnippet key={h.id} hit={h} />
      ))}
      {result.hits.length === 0 && (
        <span className="block text-[12px] text-neutral-600">title match</span>
      )}
    </a>
  );
}

/** One matched message: a two-line snippet window with the
 *  matched terms emphasized (emerald, per the activity palette). */
function HitSnippet({ hit }: { hit: SearchHit }) {
  return (
    <span className="mt-1 line-clamp-2 block text-[12px] leading-snug text-neutral-500">
      {hit.segments.map((s, i) =>
        s.hit ? (
          <span key={i} className="text-emerald-300">
            {s.t}
          </span>
        ) : (
          <span key={i}>{s.t}</span>
        ),
      )}
    </span>
  );
}
