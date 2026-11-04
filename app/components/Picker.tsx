import { useEffect, useRef, useState } from "react";
import type { ActivityRow } from "~/lib/chat-types";
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
          <div className="scrollbar-hide flex-1 overflow-y-auto">
            <WorkingOnSection
              rows={active}
              onPick={onClose}
              empty="Nothing active — star a chat to track it here."
            />
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
