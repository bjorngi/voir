import type { Route } from "./+types/api.search";
import { sessionManager } from "~/lib/sessions.server";
import { searchAll } from "~/lib/search.server";

/**
 * Cross-session search (docs/search.md) — the picker's search
 * box hits this.
 *
 *   GET /api/search?q=<terms>
 *     → { results: SearchSessionResult[] }   (see search.server.ts)
 *
 * Semantics: whitespace-separated terms, all must appear in one
 * message (or in the title). Sources merged per session, freshest
 * first: in-memory transcripts, the persisted search index, then
 * title-only matches. Sessions never opened since the index
 * shipped are findable by title until the first open indexes
 * their transcript — the honest cold-start bound (docs/search.md).
 */

export async function loader({ request }: Route.LoaderArgs) {
  const q = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 200);
  const results = await searchAll(q, sessionManager);
  return { results };
}
