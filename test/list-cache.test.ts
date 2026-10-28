import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionManager } from "../app/lib/sessions.server";

/**
 * The session/list cache (sessions.server.ts: cachedList).
 *
 * `session/list` on the real agent (pi-acp) is a scan of the
 * whole session store — head + tail reads of every session
 * file on the machine — so voir calls it once per folder on
 * every navigation and must not repeat or block on it
 * needlessly. It is a TTL cache with stale-while-revalidate:
 *
 *   1. Cold → await the RPC; later calls inside the TTL are
 *      cache hits (one RPC total).
 *   2. Concurrent calls share one in-flight RPC.
 *   3. A session created through voir is visible immediately
 *      (in-memory merge) without invalidating the cache — and
 *      the status-store prune never drops it.
 *   4. Past the TTL a call still returns instantly from the
 *      stale entry; the revalidation RPC happens in the
 *      background and lands for the *next* call.
 *   5. Unregister drops the cache (no RPC by itself).
 *
 * The counting agent speaks the minimal ACP wire voir's
 * transport needs: POST initialize / session/new /
 * session/list (in-band responses) and a GET SSE stream that
 * stays open (empty — nothing to push). See acp-client.server.ts
 * for the contract.
 */

// The status store persists under VOIR_DATA_DIR (docs/
// session-status.md): createSession auto-activates, which
// writes — isolate the test's writes from the repo's dev-data.
process.env.VOIR_DATA_DIR = await mkdtemp(join(tmpdir(), "voir-lc-"));
// Short TTL so staleness/revalidation is testable in milliseconds.
process.env.VOIR_LIST_CACHE_TTL_MS = "50";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(
  cond: () => boolean,
  ms = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await sleep(10);
  }
  return true;
}

/** Minimal ACP agent that counts session/list calls. */
async function startCountingAgent(): Promise<{
  agentUrl: string;
  listCalls: () => number;
  close: () => Promise<void>;
}> {
  let listCalls = 0;
  const sessions: Array<{ sessionId: string; cwd: string }> = [];
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      // SSE notification stream: nothing to push, stay open.
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body) as { id?: number; method?: string };
      const reply = (result: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      switch (msg.method) {
        case "initialize":
          reply({ protocolVersion: 1 });
          return;
        case "session/new": {
          const id = "cachetest-" + Math.random().toString(16).slice(2, 8);
          sessions.push({ sessionId: id, cwd: "/cachetest" });
          reply({ sessionId: id });
          return;
        }
        case "session/list": {
          listCalls++;
          reply({ sessions: [...sessions], nextCursor: null });
          return;
        }
        default:
          // ping and anything else: alive, no result.
          res.writeHead(204);
          res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert(addr && typeof addr === "object");
  return {
    agentUrl: `http://127.0.0.1:${addr.port}`,
    listCalls: () => listCalls,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        // The held-open SSE GET would keep close() pending
        // forever; drop the sockets explicitly.
        server.closeAllConnections();
      }),
  };
}

test("session/list is cached, stale-while-revalidate", async () => {
  const agent = await startCountingAgent();
  const folder = "/cachetest";
  try {
    await sessionManager.registerFolder({
      path: folder,
      agentUrl: agent.agentUrl,
      agentName: "cachetest",
    });

    // -- 1. Repeated calls inside the TTL → one RPC ---------------
    await sessionManager.listSessions(folder, "cachetest");
    await sessionManager.listSessions(folder, "cachetest");
    assert.equal(agent.listCalls(), 1, "second call is a cache hit");

    // -- 2. Concurrent calls share one in-flight RPC ---------------
    await Promise.all([
      sessionManager.listSessions(folder, "cachetest"),
      sessionManager.listSessions(folder, "cachetest"),
    ]);
    assert.equal(agent.listCalls(), 1, "concurrent calls dedupe onto one RPC");

    // -- 3. createSession doesn't invalidate -----------------------
    // The new session is visible via the in-memory merge, and the
    // prune below must not drop its auto-set "active" status even
    // though the cached list predates it.
    const created = await sessionManager.createSession(folder, "t", "cachetest");
    const afterCreate = await sessionManager.listSessions(folder, "cachetest");
    assert.equal(agent.listCalls(), 1, "createSession keeps the cache warm");
    assert.ok(
      afterCreate.some((s) => s.id === created.id),
      "the created session is listed (in-memory merge)",
    );

    // -- 4. Past the TTL: serve stale, revalidate behind ------------
    await sleep(80);
    const stale = await sessionManager.listSessions(folder, "cachetest");
    assert.equal(agent.listCalls(), 1, "a stale entry serves without waiting");
    assert.ok(
      stale.some((s) => s.id === created.id),
      "the stale list still shows in-memory sessions",
    );
    // The background revalidation RPC completes...
    assert.ok(
      await until(() => agent.listCalls() === 2),
      "the background refresh issues the RPC",
    );
    // ...and lands for the next call.
    await sessionManager.listSessions(folder, "cachetest");
    assert.equal(agent.listCalls(), 2, "the refreshed entry is served");

    // -- 5. Unregister drops the cache -------------------------------
    await sessionManager.unregisterFolder(folder, "cachetest");
    assert.equal(agent.listCalls(), 2, "unregister alone makes no RPC");
    await sessionManager.registerFolder({
      path: folder,
      agentUrl: agent.agentUrl,
      agentName: "cachetest",
    });
    await sessionManager.listSessions(folder, "cachetest");
    assert.equal(agent.listCalls(), 3, "a re-registered agent starts cold");
  } finally {
    await sessionManager.unregisterFolder(folder, "cachetest").catch(() => {});
    await agent.close();
  }
});