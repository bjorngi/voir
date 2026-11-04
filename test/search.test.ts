import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  searchTerms,
  matchMessage,
  buildSnippet,
  searchAll,
  writeSearchIndex,
  readSearchIndex,
  type SearchManagerLike,
  type SearchSessionResult,
} from "../app/lib/search.server";
import type { ChatMessage } from "../app/lib/chat-types";
import type { SessionState } from "../app/lib/sessions.server";

// Point the index at a fresh tmpdir BEFORE the first write — the
// env is read lazily per call (the session-status convention).
process.env.VOIR_DATA_DIR = mkdtempSync(join(tmpdir(), "voir-search-"));

function textMsg(
  id: string,
  role: "user" | "agent",
  text: string,
  at = 1_000,
): ChatMessage {
  return { id, role, kind: "text", text, at };
}

function session(
  id: string,
  opts: {
    title?: string;
    createdAt?: number;
    messages?: ChatMessage[];
    stub?: boolean;
  } = {},
): SessionState {
  return {
    id,
    title: opts.title,
    createdAt: opts.createdAt ?? 1_000,
    messages: opts.messages ?? [],
    busy: false,
    stub: opts.stub,
  };
}

test("searchTerms: whitespace split, lowercased, empties dropped", () => {
  assert.deepEqual(searchTerms("  Push   PROXY "), ["push", "proxy"]);
  assert.deepEqual(searchTerms("   "), []);
});

test("matchMessage: AND over terms, case-insensitive", () => {
  assert.equal(matchMessage("Fixed the push proxy in Caddy", ["push", "proxy"]), true);
  assert.equal(matchMessage("Fixed the push proxy", ["push", "caddy"]), false);
  assert.equal(matchMessage("PUSH", ["push"]), true);
});

test("buildSnippet: window around first hit, terms marked, elided ends", () => {
  const long =
    "x".repeat(200) + " the push proxy needed a restart " + "y".repeat(200);
  const segs = buildSnippet(long, ["push"]);
  const flat = segs.map((s) => s.t).join("");
  assert.ok(flat.startsWith("…"), "leading elision when windowed");
  assert.ok(flat.endsWith("…"), "trailing elision when windowed");
  // Bounded window: … + ≤48 before + term + ≤140 after + …
  assert.ok(flat.length <= 1 + 48 + "push".length + 140 + 1);
  assert.ok(flat.includes("push proxy needed a restart"), "the matched phrase and its window ride along");
  const hit = segs.filter((s) => s.hit).map((s) => s.t).join("");
  assert.equal(hit, "push");
  // Both terms inside the window get marked.
  const segs2 = buildSnippet("push proxy push", ["push"]);
  assert.equal(segs2.filter((s) => s.hit).length, 2);
});

test("index roundtrip: write, read back; unknown/v1-guard returns null", async () => {
  const s = session("s-1", {
    title: "Caddy push proxy",
    messages: [textMsg("m1", "agent", "We hardened the push proxy."), textMsg("m2", "user", "nice")],
  });
  await writeSearchIndex("/home/bjorn/code/voir", "main", s);
  const back = readSearchIndex("/home/bjorn/code/voir", "main", "s-1");
  assert.equal(back?.id, "s-1");
  assert.equal(back?.title, "Caddy push proxy");
  assert.deepEqual(
    back?.messages.map((m) => m.text),
    ["We hardened the push proxy.", "nice"],
  );
  // Different agent name (same path) is a different store.
  assert.equal(readSearchIndex("/home/bjorn/code/voir", "other", "s-1"), null);
  // Missing file → null, not a throw.
  assert.equal(readSearchIndex("/home/bjorn/code/voir", "main", "nope"), null);
});

test("searchAll: merges memory, index and title sources", async () => {
  const held = session("held-1", {
    title: "Active chat",
    createdAt: 5_000,
    messages: [
      textMsg("h1", "agent", "The proxy restart fixed it.", 5_000),
      textMsg("h2", "user", "proxy again?", 5_100),
    ],
  });
  const stubIndexed = session("stub-1", {
    title: "Old indexed chat",
    createdAt: 4_000,
    stub: true,
  });
  await writeSearchIndex("/w/a", "main", {
    ...stubIndexed,
    messages: [textMsg("i1", "agent", "Indexed note about the proxy.", 4_000)],
  });
  const stubTitleOnly = session("stub-2", {
    title: "proxy config cleanup",
    createdAt: 3_000,
    stub: true,
  });
  const noMatch = session("stub-3", { title: "unrelated", stub: true });

  const manager: SearchManagerLike = {
    listFolders: () => [{ path: "/w/a", agentName: "main" }],
    listSessions: async () => [held, stubIndexed, stubTitleOnly, noMatch],
    agentOfSession: (id) =>
      [held, stubIndexed, stubTitleOnly, noMatch].some((s) => s.id === id)
        ? { path: "/w/a", agentName: "main" }
        : undefined,
  };

  const results = await searchAll("proxy", manager);
  assert.equal(results.length, 3, "the noMatch session is excluded");
  assert.deepEqual(
    results.map((r) => r.sessionId),
    // Freshest first: held (5_100) > stubIndexed (4_000) > title (3_000).
    ["held-1", "stub-1", "stub-2"],
  );
  const byId = new Map(results.map((r) => [r.sessionId, r]));
  assert.equal(byId.get("held-1")?.source, "memory");
  assert.equal(byId.get("held-1")?.hits.length, 2, "both memory hits");
  assert.equal(byId.get("stub-1")?.source, "index");
  assert.equal(byId.get("stub-1")?.hits[0]?.id, "i1");
  assert.equal(byId.get("stub-2")?.source, "title");
  assert.equal(byId.get("stub-2")?.hits.length, 0);

  // AND terms: no single message carries both.
  const both = await searchAll("proxy restart", manager);
  assert.deepEqual(
    both.map((r) => r.sessionId),
    ["held-1"],
    "only the session with one message carrying both terms; stub-1's index message and both titles fail the AND",
  );

  // Empty query: no work, no results.
  assert.deepEqual(await searchAll("   ", manager), []);
});

test("searchAll: held-empty beats a stale index (memory is truth)", async () => {
  const heldEmpty = session("held-2", { title: "replayed empty", createdAt: 9_000 });
  await writeSearchIndex("/w/b", "main", {
    ...heldEmpty,
    messages: [textMsg("old-1", "agent", "stale indexed proxy talk", 8_000)],
  });
  const manager: SearchManagerLike = {
    listFolders: () => [{ path: "/w/b", agentName: "main" }],
    listSessions: async () => [heldEmpty],
    agentOfSession: () => ({ path: "/w/b", agentName: "main" }),
  };
  // The stale index mentions "proxy" but the session is held —
  // memory (empty) wins, and the title doesn't match either.
  const proxy = await searchAll("proxy", manager);
  assert.equal(proxy.length, 0);
  // A title match still surfaces the session, with no message
  // hits from the stale index.
  const title = await searchAll("replayed", manager);
  assert.equal(title.length, 1);
  assert.equal(title[0].source, "title");
  assert.equal(title[0].hits.length, 0);
});

test("searchAll: multi-agent paths are visited once per path, owner-resolved", async () => {
  // Two agents share a path; listSessions(path) (unnamed) merges
  // their sessions — searchAll must not double-count ids, and the
  // index read must use the OWNING agent's store.
  const owned = session("uuid-shared", { title: "untitled", stub: true });
  await writeSearchIndex("/w/c", "engine-b", {
    ...owned,
    title: "engine-b chat",
    messages: [textMsg("b1", "agent", "proxy work in engine b", 7_000)],
  });
  const seen: string[] = [];
  const manager: SearchManagerLike = {
    listFolders: () => [
      { path: "/w/c", agentName: "engine-a" },
      { path: "/w/c", agentName: "engine-b" },
    ],
    listSessions: async (folder) => {
      seen.push(folder);
      return [owned];
    },
    agentOfSession: () => ({ path: "/w/c", agentName: "engine-b" }),
  };
  const results: SearchSessionResult[] = await searchAll("proxy", manager);
  assert.deepEqual(seen, ["/w/c"], "one visit per path");
  assert.equal(results.length, 1);
  assert.equal(results[0].source, "index");
});

test("searchAll: hits per session are capped, sessions sorted by recency", async () => {
  const many: ChatMessage[] = Array.from({ length: 10 }, (_, i) =>
    textMsg(`m${i}`, "agent", `proxy note ${i}`, i + 1),
  );
  const s = session("many-1", { title: "chatty", createdAt: 100, messages: many });
  const older = session("older-1", { title: "proxy but old", createdAt: 50 });
  const manager: SearchManagerLike = {
    listFolders: () => [{ path: "/w/d" }],
    listSessions: async () => [s, older],
    agentOfSession: () => ({ path: "/w/d" }),
  };
  const results = await searchAll("proxy", manager);
  assert.equal(results.length, 2);
  assert.ok(results[0].at >= results[1].at, "sorted newest first");
  assert.equal(results[0].hits.length, 3, "hit cap");
});

// Torn down last so a failed assertion still cleans up: node:test
// runs tests in file order.
test("teardown", () => {
  rmSync(process.env.VOIR_DATA_DIR!, { recursive: true, force: true });
});
