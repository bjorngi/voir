import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage } from "./chat-types";
import type { SessionState } from "./sessions.server";

/**
 * Cross-session transcript search (docs/search.md).
 *
 * Three sources merge per session, freshest first:
 *
 *   1. the in-memory transcript — loaded/active sessions;
 *   2. the persisted search index, one JSON file per session
 *      under `$VOIR_DATA_DIR/search-index/<agentHash>/` — written
 *      (debounced) on every live message and once after each
 *      session/load replay, so transcripts survive restarts and
 *      cold sessions stay findable;
 *   3. the session title — every session the agent lists, even
 *      ones never opened (pi titles sessions from the first
 *      prompt, so title search has real recall on its own).
 *
 * The index is a search-only artifact. The chat surface always
 * renders agent truth (the session/load replay); staleness here
 * costs at most an outdated snippet or a jump-to that falls back
 * to a plain chat open. Held (non-stub) sessions never read
 * their index — memory is authoritative, even when empty.
 *
 * VOIR_DATA_DIR is read lazily per call (the session-status
 * convention) so tests can point it at a fresh tmpdir after the
 * static import.
 */

interface IndexMessage {
  id: string;
  role: string;
  at: number;
  text: string;
}

interface SessionIndex {
  v: 1;
  id: string;
  title: string | null;
  /** Epoch ms of the index write — informational, not a sort key. */
  at: number;
  messages: IndexMessage[];
}

function indexRoot(): string {
  return join(process.env.VOIR_DATA_DIR ?? "dev-data", "search-index");
}

/** Stable directory name per agent (path + name — several agents
 *  can share one path, and their session stores are separate). */
function agentHash(path: string, name?: string): string {
  return createHash("sha1")
    .update(`${path}\u0000${name ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

function indexPath(path: string, name: string | undefined, sessionId: string): string {
  return join(indexRoot(), agentHash(path, name), `${sessionId}.json`);
}

/** Only kind=text messages are searchable (tool JSON and plan
 *  checklists read as noise; that can change — the index schema
 *  is versioned for it). */
function searchableMessages(messages: ChatMessage[]): IndexMessage[] {
  const out: IndexMessage[] = [];
  for (const m of messages) {
    if (m.kind !== "text") continue;
    const text = m.text?.trim();
    if (!text) continue;
    out.push({ id: m.id, role: m.role, at: m.at, text: m.text });
  }
  return out;
}

export async function writeSearchIndex(
  path: string,
  name: string | undefined,
  session: Pick<SessionState, "id" | "title" | "messages">,
): Promise<void> {
  const file = indexPath(path, name, session.id);
  const dir = join(file, "..");
  await mkdir(dir, { recursive: true });
  const index: SessionIndex = {
    v: 1,
    id: session.id,
    title: session.title ?? null,
    at: Date.now(),
    messages: searchableMessages(session.messages),
  };
  // Atomic (tmp + rename): a search read never observes a torn
  // write, the same guarantee the session-status store makes.
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(index));
  await rename(tmp, file);
}

export function readSearchIndex(
  path: string,
  name: string | undefined,
  sessionId: string,
): SessionIndex | null {
  // Sync on purpose: searches are user-initiated and rare, the
  // files are small, and a linear read keeps the search path
  // await-free per session (the only async work is listSessions).
  try {
    const raw = readFileSync(indexPath(path, name, sessionId), "utf-8");
    const parsed = JSON.parse(raw) as SessionIndex;
    if (parsed?.v !== 1 || parsed.id !== sessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------
// Debounced writes — one timer per session id (UUIDs are unique
// across agents, so the id alone is a safe key). Streaming bursts
// coalesce into one write per quiet window; loadSession passes
// delay 0 (the replay IS the complete truth).
// -----------------------------------------------------------------------

const pending = new Map<string, NodeJS.Timeout>();

export function scheduleSearchIndex(
  path: string,
  name: string | undefined,
  session: Pick<SessionState, "id" | "title" | "messages">,
  delayMs = 3000,
): void {
  const old = pending.get(session.id);
  if (old) clearTimeout(old);
  const t = setTimeout(() => {
    pending.delete(session.id);
    void writeSearchIndex(path, name, session).catch((err) =>
      console.error("[search] index write failed", err),
    );
  }, delayMs);
  // A straggling debounce must not hold the process open on
  // SIGTERM (the shutdown path waits on server.close).
  t.unref?.();
  pending.set(session.id, t);
}

// -----------------------------------------------------------------------
// Matching — pure and unit-tested (test/search.test.ts)
// -----------------------------------------------------------------------

export function searchTerms(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** AND semantics: every term must appear in one message (the
 *  standard find-in-page contract — terms spread across a
 *  session don't match, which keeps results honest). */
export function matchMessage(text: string, terms: string[]): boolean {
  const low = text.toLowerCase();
  return terms.every((t) => low.includes(t));
}

export interface SearchHit {
  id: string;
  role: string;
  at: number;
  /** Snippet segments around the first match; `hit: true` spans
   *  are the matched terms (rendered emphasized in the picker). */
  segments: Array<{ t: string; hit: boolean }>;
}

const SNIPPET_BEFORE = 48;
const SNIPPET_AFTER = 140;

/** Window the text around the earliest term occurrence and mark
 *  every term hit inside it. */
export function buildSnippet(text: string, terms: string[]): SearchHit["segments"] {
  const low = text.toLowerCase();
  let first = -1;
  let firstLen = 0;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i !== -1 && (first === -1 || i < first)) {
      first = i;
      firstLen = t.length;
    }
  }
  // No occurrence shouldn't happen (the caller matched first),
  // but degrade to a head-window instead of throwing.
  if (first === -1) {
    return [{ t: text.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER), hit: false }];
  }
  const start = Math.max(0, first - SNIPPET_BEFORE);
  const end = Math.min(text.length, first + firstLen + SNIPPET_AFTER);
  const segs: SearchHit["segments"] = [];
  if (start > 0) segs.push({ t: "…", hit: false });
  let i = start;
  while (i < end) {
    // Next term occurrence at/after i, inside the window.
    let next = -1;
    let len = 0;
    for (const t of terms) {
      const j = low.indexOf(t, i);
      if (j !== -1 && j < end && (next === -1 || j < next)) {
        next = j;
        len = t.length;
      }
    }
    if (next === -1) {
      segs.push({ t: text.slice(i, end), hit: false });
      break;
    }
    if (next > i) segs.push({ t: text.slice(i, next), hit: false });
    segs.push({ t: text.slice(next, next + len), hit: true });
    i = next + len;
  }
  if (end < text.length) segs.push({ t: "…", hit: false });
  return segs;
}

// -----------------------------------------------------------------------
// The cross-folder search
// -----------------------------------------------------------------------

export interface SearchSessionResult {
  folder: string;
  sessionId: string;
  title: string | null;
  /** Sort key: max(session updatedAt/createdAt, hit timestamps). */
  at: number;
  /** Where the matched transcript came from. */
  source: "memory" | "index" | "title";
  hits: SearchHit[];
}

const MAX_SESSIONS = 40;
const MAX_HITS_PER_SESSION = 3;

/** What searchAll needs from the session manager — structural, so
 *  tests drive it with a plain object and the route passes the
 *  real singleton. */
export interface SearchManagerLike {
  listFolders(): Array<{ path: string; agentName?: string }>;
  listSessions(folder: string, name?: string): Promise<SessionState[]>;
  agentOfSession(sessionId: string): { path: string; agentName?: string } | undefined;
}

export async function searchAll(
  q: string,
  manager: SearchManagerLike,
): Promise<SearchSessionResult[]> {
  const terms = searchTerms(q);
  if (terms.length === 0) return [];
  const out: SearchSessionResult[] = [];
  // Once per path: listSessions(path) merges every agent under
  // it (and hydrates stubs into their owning maps, so
  // agentOfSession resolves correctly below).
  const paths = [...new Set(manager.listFolders().map((s) => s.path))];
  for (const path of paths) {
    let sessions: SessionState[];
    try {
      sessions = await manager.listSessions(path);
    } catch {
      continue; // a dead agent degrades its own sessions away
    }
    for (const session of sessions) {
      // Held (non-stub) → the in-memory transcript is the truth,
      // even when empty (replayed empty beats a stale index).
      // Otherwise the persisted index, if this session was ever
      // seen. Title alone matches as a last resort.
      const owner = manager.agentOfSession(session.id);
      const held = !session.stub && owner !== undefined;
      const idx =
        held || !owner
          ? null
          : readSearchIndex(owner.path, owner.agentName, session.id);
      const title = session.title ?? idx?.title ?? null;
      // Held transcripts carry all message kinds (tool/plan are
      // not searchable); the index stores text-only records — no
      // kind field to check. One pool shape, one loop.
      const pool: Array<{
        id: string;
        role: string;
        at: number;
        text?: string;
        kind?: string;
      }> = held ? session.messages : (idx?.messages ?? []);
      const hits: SearchHit[] = [];
      for (const m of pool) {
        if (hits.length >= MAX_HITS_PER_SESSION) break;
        if (held && m.kind !== "text") continue;
        const text = m.text ?? "";
        if (!text || !matchMessage(text, terms)) continue;
        hits.push({
          id: m.id,
          role: m.role,
          at: m.at,
          segments: buildSnippet(text, terms),
        });
      }
      const titleHit = title !== null && matchMessage(title, terms);
      if (hits.length === 0 && !titleHit) continue;
      const lastHitAt = hits.length ? Math.max(...hits.map((h) => h.at)) : 0;
      out.push({
        folder: path,
        sessionId: session.id,
        title,
        at: Math.max(session.createdAt, lastHitAt),
        source: hits.length > 0 ? (held ? "memory" : "index") : "title",
        hits,
      });
      if (out.length >= MAX_SESSIONS) return sortResults(out);
    }
  }
  return sortResults(out);
}

function sortResults(out: SearchSessionResult[]): SearchSessionResult[] {
  return out.sort((a, b) => b.at - a.at);
}
