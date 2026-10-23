import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SessionStatusStore,
  FLUSH_DEBOUNCE_MS,
} from "../app/lib/session-status.server";
import {
  activityOf,
  type FolderState,
  type SessionState,
} from "../app/lib/sessions.server";

/**
 * The session-status store (docs/session-status.md) — pure
 * data-layer tests: round-trip, persistence, pruning,
 * tolerance for corrupt files, and the `activityOf` derivation
 * matrix. The end-to-end wiring (auto-activation, overlay,
 * snapshot, API) lives in test/active-sessions.test.ts.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "voir-status-"));
  return join(dir, "session-status.json");
}

// -----------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------

test("store: round trip — absence is the pile, words are exclusive", async () => {
  const store = new SessionStatusStore(await tmpFile());
  // Fresh install: nothing in the store, everything is the pile.
  assert.equal(store.getStatus("/w/feat-42", "s1"), undefined);

  store.setStatus("/w/feat-42", "s1", "active");
  assert.equal(store.getStatus("/w/feat-42", "s1"), "active");

  // Setting one word clears the other — exclusive by construction.
  store.setStatus("/w/feat-42", "s1", "archived");
  assert.equal(store.getStatus("/w/feat-42", "s1"), "archived");
  store.setStatus("/w/feat-42", "s1", "active");
  assert.equal(store.getStatus("/w/feat-42", "s1"), "active");

  // "none" = back to the pile.
  store.setStatus("/w/feat-42", "s1", "none");
  assert.equal(store.getStatus("/w/feat-42", "s1"), undefined);

  // Path normalization: a trailing slash is the same folder.
  store.setStatus("/w/feat-42/", "s1", "active");
  assert.equal(store.getStatus("/w/feat-42", "s1"), "active");
  await store.flush();
});

test("store: persistence across instances via atomic flush", async () => {
  const file = await tmpFile();
  const a = new SessionStatusStore(file);
  a.setStatus("/w/feat-42", "s1", "active");
  a.setStatus("/w/other", "s2", "archived");
  await a.flush();

  // Atomic: no tmp file left behind by the rename.
  assert.deepEqual(await readdir(dirname(file)), ["session-status.json"]);

  // A fresh instance (simulated restart) reads it back.
  const b = new SessionStatusStore(file);
  assert.equal(b.getStatus("/w/feat-42", "s1"), "active");
  assert.equal(b.getStatus("/w/other", "s2"), "archived");
  assert.equal(b.getStatus("/w/other", "s3"), undefined);
});

test("store: the debounced flush coalesces a burst of writes", async () => {
  const file = await tmpFile();
  const store = new SessionStatusStore(file);
  store.setStatus("/w", "s1", "active");
  store.setStatus("/w", "s2", "active");
  store.setStatus("/w", "s1", "archived");
  // All inside one debounce window → one write, last state wins.
  await sleep(FLUSH_DEBOUNCE_MS + 150);
  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.folders["/w"].s1.status, "archived");
  assert.equal(raw.folders["/w"].s2.status, "active");
  await store.flush();
});

test("store: listActive returns only active entries", async () => {
  const store = new SessionStatusStore(await tmpFile());
  store.setStatus("/w/a", "s1", "active");
  store.setStatus("/w/a", "s2", "archived");
  store.setStatus("/w/b", "s3", "active");
  const active = store.listActive();
  assert.equal(active.length, 2);
  assert.ok(active.some((e) => e.folder === "/w/a" && e.sessionId === "s1"));
  assert.ok(active.some((e) => e.folder === "/w/b" && e.sessionId === "s3"));
  await store.flush();
});

test("store: prune keeps known ids and drops unknown ones", async () => {
  const store = new SessionStatusStore(await tmpFile());
  store.setStatus("/w", "s1", "active");
  store.setStatus("/w", "s2", "archived");
  store.setStatus("/w", "s3", "active");
  store.setStatus("/other", "s9", "active");

  // A fresh session/list answered: s1, s2 known; s3 is gone.
  store.prune("/w", new Set(["s1", "s2", "s-never-stored"]));

  assert.equal(store.getStatus("/w", "s1"), "active");
  // Archived entries follow the same rule — gone is gone.
  assert.equal(store.getStatus("/w", "s2"), "archived");
  assert.equal(store.getStatus("/w", "s3"), undefined);
  // Other folders are untouched.
  assert.equal(store.getStatus("/other", "s9"), "active");
  await store.flush();
});

test("store: prune to empty removes the folder section", async () => {
  const file = await tmpFile();
  const store = new SessionStatusStore(file);
  store.setStatus("/w", "s1", "active");
  store.setStatus("/other", "s2", "active");
  store.prune("/w", new Set());
  assert.equal(store.getStatus("/w", "s1"), undefined);
  assert.equal(store.getStatus("/other", "s2"), "active");
  await store.flush();
  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(Object.keys(raw.folders), ["/other"]);
});

test("store: corrupt file degrades to empty, keeps working", async () => {
  const file = await tmpFile();
  await writeFile(file, "{ not json", "utf8");
  const store = new SessionStatusStore(file);
  assert.equal(store.getStatus("/w", "s1"), undefined);
  store.setStatus("/w", "s1", "active");
  assert.equal(store.getStatus("/w", "s1"), "active");
  await store.flush();
  const b = new SessionStatusStore(file);
  assert.equal(b.getStatus("/w", "s1"), "active");
});

test("store: sanitize drops malformed entries and wrong versions", async () => {
  const file = await tmpFile();
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      folders: {
        "/w": {
          "s1": { status: "done", at: 1 }, // word we never wrote
          "s2": { status: "active", at: 2 },
          "s3": { status: "active" }, // missing at
        },
      },
    }),
    "utf8",
  );
  const store = new SessionStatusStore(file);
  assert.equal(store.getStatus("/w", "s1"), undefined);
  assert.equal(store.getStatus("/w", "s2"), "active");
  assert.equal(store.getStatus("/w", "s3"), undefined);

  // A wrong version means "start empty" (nothing needs migrating).
  await writeFile(
    file,
    JSON.stringify({ version: 99, folders: { "/w": { "s2": { status: "active", at: 2 } } } }),
    "utf8",
  );
  const b = new SessionStatusStore(file);
  assert.equal(b.getStatus("/w", "s2"), undefined);
});

// -----------------------------------------------------------------------
// activityOf — the live-state derivation matrix
// -----------------------------------------------------------------------

function folderOf(status: "ok" | "degraded" = "ok"): FolderState {
  return {
    path: "/w/feat-42",
    agentUrl: "http://127.0.0.1:1/",
    registeredAt: 0,
    status,
    lastSeenAt: 0,
    sessions: new Map(),
    activeSessionId: null,
    availableCommands: [],
    availableModels: [],
    availableModes: [],
    currentModeId: null,
    currentModelId: null,
  };
}

function sessionOf(o: Partial<SessionState>): SessionState {
  return {
    id: "s1",
    createdAt: 1_000,
    messages: [],
    busy: false,
    ...o,
  };
}

test("activityOf: offline wins over everything — busy isn't trustworthy on a dead leg", () => {
  const state = folderOf("degraded");
  const session = sessionOf({ busy: true, stub: true, queueDepth: 3 });
  assert.equal(activityOf(state, session).state, "offline");
});

test("activityOf: stubs are idle — no live claim, queue unknown", () => {
  const a = activityOf(folderOf(), sessionOf({ stub: true }));
  assert.equal(a.state, "idle");
  assert.equal(a.queued, 0);
  // The stub priority sits above busy: a stub never claims working.
  const b = activityOf(folderOf(), sessionOf({ stub: true, busy: true }));
  assert.equal(b.state, "idle");
});

test("activityOf: busy is working, with the queued badge from agent truth", () => {
  const a = activityOf(folderOf(), sessionOf({ busy: true, queueDepth: 2 }));
  assert.equal(a.state, "working");
  assert.equal(a.queued, 2);
  assert.equal(
    activityOf(folderOf(), sessionOf({ busy: true })).queued,
    0,
  );
});

test("activityOf: held sessions are waiting (messages) or fresh (none)", () => {
  const waiting = activityOf(
    folderOf(),
    sessionOf({ messages: [{ id: "m", role: "user", kind: "text", text: "hi", at: 5_000 }] }),
  );
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.lastActivityAt, 5_000);

  const fresh = activityOf(folderOf(), sessionOf({}));
  assert.equal(fresh.state, "fresh");
  // No messages → createdAt is the recency proxy.
  assert.equal(fresh.lastActivityAt, 1_000);
});

test("activityOf: a degraded leg reports offline even for quiet sessions", () => {
  const a = activityOf(folderOf("degraded"), sessionOf({}));
  assert.equal(a.state, "offline");
});