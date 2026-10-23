import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionStatus } from "./chat-types";

/**
 * The session-status store (docs/session-status.md): voir's own,
 * persistent membership overlay on agent truth.
 *
 * ACP's `session/list` carries no flag field and no mutation
 * RPC, so "what am I working on" has no portable home in the
 * agent — it lives here. The store is keyed by folder path +
 * session id (a UUID unique across the agents under a path),
 * NOT by agent name, so statuses survive launcher restarts
 * and re-registrations under a new agentUrl.
 *
 * The words:
 *
 *   active    written — member of the "Working on" shortlist.
 *             Auto-set by SessionManager on every deliberate
 *             act of working (createSession, sendMessage).
 *   archived  written — the junk drawer; hidden from lists.
 *   (absent)  the pile — the default, never written.
 *
 * Sessions ids are UUIDs that outlive agent processes; the
 * store outlives sessions. Orphaned entries (agent lost the
 * session) are pruned by SessionManager.listSessions — only
 * when the folder's agents just answered session/list — and
 * NEVER on DELETE /api/folders: the launcher (bin/acp-spawn)
 * unregisters on every teardown, so DELETE is routine, not a
 * deliberate human act.
 *
 * Path: `$VOIR_DATA_DIR/session-status.json` (default
 * `dev-data/`) — the same "durable state on the filesystem"
 * convention as push.server.ts's subscription registry. Reads
 * are synchronous (folderSummary stamps statuses on every
 * loader call and must not grow an await); the file is tiny
 * and read once per process, lazily. Writes are debounced and
 * atomic (tmp + rename): auto-activation means a write per
 * prompt, and a burst must coalesce, never interleave.
 */

/** What `setStatus` accepts: a status word, or "none" for back to the pile. */
export type SetStatus = SessionStatus | "none";

interface StatusEntry {
  status: SessionStatus;
  /** Epoch ms of the last transition into the current status. */
  at: number;
}

interface StoreFile {
  version: 1;
  folders: Record<string, Record<string, StatusEntry>>;
}

export const FLUSH_DEBOUNCE_MS = 500;

function storeFile(): string {
  return join(
    process.env.VOIR_DATA_DIR ?? "dev-data",
    "session-status.json",
  );
}

/** Same semantics as `normalizeFolder` in sessions.server.ts (no import: one-way deps, the store must not reach back into the manager). */
function normalizeFolder(folder: string): string {
  return folder.replace(/\/+$/, "");
}

/**
 * Validate a parsed file into a clean shape. A hand-edited or
 * corrupt file must never crash the server: malformed entries
 * are dropped, and a wrong `version` means "start empty"
 * (nothing has shipped that needs migrating).
 */
function sanitize(parsed: unknown): StoreFile | null {
  if (!parsed || typeof parsed !== "object") return null;
  const { version, folders } = parsed as {
    version?: unknown;
    folders?: unknown;
  };
  if (version !== 1 || !folders || typeof folders !== "object") {
    return null;
  }
  const clean: StoreFile["folders"] = {};
  for (const [path, section] of Object.entries(
    folders as Record<string, unknown>,
  )) {
    if (!section || typeof section !== "object") continue;
    const entries: Record<string, StatusEntry> = {};
    for (const [id, entry] of Object.entries(
      section as Record<string, unknown>,
    )) {
      const e = entry as { status?: unknown; at?: unknown };
      if (
        (e.status === "active" || e.status === "archived") &&
        typeof e.at === "number"
      ) {
        entries[id] = { status: e.status, at: e.at };
      }
    }
    if (Object.keys(entries).length > 0) clean[path] = entries;
  }
  return { version: 1, folders: clean };
}

export class SessionStatusStore {
  /** Lazily loaded file state; null until first access. */
  private data: StoreFile | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  /** Serializes flushes so concurrent writers never interleave. */
  private flushing: Promise<void> = Promise.resolve();

  /**
   * @param fileOverride explicit store file — tests point this
   * at a tmpdir. Unset (the app's singleton): $VOIR_DATA_DIR/
   * session-status.json.
   */
  constructor(private readonly fileOverride?: string) {}

  private path(): string {
    return this.fileOverride ?? storeFile();
  }

  getStatus(folder: string, sessionId: string): SessionStatus | undefined {
    return this.load().folders[normalizeFolder(folder)]?.[sessionId]?.status;
  }

  /**
   * Set or clear a session's status. Setting `active` clears
   * `archived` and vice versa; `"none"` removes the entry
   * entirely (back to the pile). Re-setting the current
   * status still bumps `at` — every act of working refreshes
   * the transition time. Persists via the debounced flush.
   */
  setStatus(folder: string, sessionId: string, status: SetStatus): void {
    const data = this.load();
    const path = normalizeFolder(folder);
    if (status === "none") {
      const section = data.folders[path];
      if (!section || !(sessionId in section)) return;
      delete section[sessionId];
      if (Object.keys(section).length === 0) delete data.folders[path];
    } else {
      let section = data.folders[path];
      if (!section) {
        section = {};
        data.folders[path] = section;
      }
      section[sessionId] = { status, at: Date.now() };
    }
    this.scheduleFlush();
  }

  /** All active entries across folders — feeds the snapshot. */
  listActive(): Array<{ folder: string; sessionId: string; at: number }> {
    const out: Array<{ folder: string; sessionId: string; at: number }> = [];
    for (const [folder, section] of Object.entries(this.load().folders)) {
      for (const [sessionId, entry] of Object.entries(section)) {
        if (entry.status === "active") {
          out.push({ folder, sessionId, at: entry.at });
        }
      }
    }
    return out;
  }

  /**
   * Drop a folder's entries for session ids the agent's fresh
   * `session/list` didn't mention. Called by
   * SessionManager.listSessions only — never on a timer, never
   * while degraded or unregistered. Keeps archived entries
   * subject to the same rule: gone is gone.
   */
  prune(folder: string, knownIds: Set<string>): void {
    const data = this.load();
    const path = normalizeFolder(folder);
    const section = data.folders[path];
    if (!section) return;
    const kept = Object.entries(section).filter(([id]) =>
      knownIds.has(id),
    );
    if (kept.length === Object.keys(section).length) return;
    if (kept.length === 0) delete data.folders[path];
    else {
      data.folders[path] = Object.fromEntries(kept);
    }
    this.scheduleFlush();
  }

  /** Write the current state to disk now (cancels a pending debounce). */
  flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushing = this.flushing.then(() => this.write());
    return this.flushing;
  }

  private scheduleFlush() {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private load(): StoreFile {
    if (this.data) return this.data;
    let data: StoreFile = { version: 1, folders: {} };
    try {
      const clean = sanitize(
        JSON.parse(readFileSync(this.path(), "utf8")),
      );
      if (clean) data = clean;
    } catch (err) {
      // ENOENT = fresh install, not an error. Anything else
      // (corrupt JSON) also degrades to "start empty" — the
      // worst case is losing the shortlist, never the chat.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[session-status] could not read ${this.path()}: ${(err as Error).message} — starting empty`,
        );
      }
    }
    this.data = data;
    return data;
  }

  private async write(): Promise<void> {
    if (!this.data) return;
    const file = this.path();
    try {
      await mkdir(dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      await writeFile(tmp, JSON.stringify(this.data, null, 2) + "\n");
      // Atomic swap: a reader (or a kill -9 mid-write) never
      // sees a half-written store.
      await rename(tmp, file);
    } catch (err) {
      console.error(
        `[session-status] flush failed: ${(err as Error).message}`,
      );
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  // Same HMR-cache contract as `__radharc_sessions` in
  // sessions.server.ts: the key pins the singleton across
  // dev-server reloads. Renaming it would orphan any process
  // mid-reload (old bundle's value pinned on globalThis, new
  // bundle constructs a fresh store and the debounced flush
  // timer of the old one would fight the new one for the file).
  var __radharc_session_status: SessionStatusStore | undefined;
}

export const sessionStatusStore: SessionStatusStore =
  globalThis.__radharc_session_status ??
  (globalThis.__radharc_session_status = new SessionStatusStore());