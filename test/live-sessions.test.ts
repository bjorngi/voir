import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionManager } from "../app/lib/sessions.server";

/**
 * findOrLoadSession's live-view trust (sessions.server.ts).
 *
 * pi-acp charges a fresh pi child per session/load, so a chat
 * page that reloads a session voir itself just created pays a
 * second agent boot for nothing. The contract under test:
 *
 *   1. A session created under the current client generation
 *      is the live view — findOrLoadSession returns it from
 *      memory with NO session/load RPC, even while it is still
 *      empty (there is nothing to replay).
 *   2. A re-registration with a new bridge URL (the
 *      launcher-restart signature) bumps the folder's
 *      clientEpoch; the same empty session then reloads from
 *      agent truth — the restart heal path stays intact.
 *   3. An empty stub hydrated from session/list still reloads.
 */

// The status store persists under VOIR_DATA_DIR (docs/
// session-status.md): createSession auto-activates, which
// writes — isolate the test's writes from the repo's dev-data.
process.env.VOIR_DATA_DIR = await mkdtemp(join(tmpdir(), "voir-live-"));

/** Minimal counting ACP agent: records every session/load. */
async function startLoadCountingAgent(): Promise<{
  agentUrl: string;
  loadCalls: () => string[];
  close: () => Promise<void>;
}> {
  const loads: string[] = [];
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
      const msg = JSON.parse(body) as {
        id?: number;
        method?: string;
        params?: { sessionId?: string };
      };
      const reply = (result: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      switch (msg.method) {
        case "initialize":
          reply({ protocolVersion: 1 });
          return;
        case "session/new":
          reply({
            sessionId: "live-" + Math.random().toString(16).slice(2, 8),
          });
          return;
        case "session/list":
          // One foreign session so the stub path is exercisable.
          reply({
            sessions: [
              {
                sessionId: "stub-1",
                cwd: "/livetest",
                updatedAt: new Date().toISOString(),
              },
            ],
            nextCursor: null,
          });
          return;
        case "session/load": {
          const sid = msg.params?.sessionId ?? "?";
          loads.push(sid);
          reply({ sessionId: sid });
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
    loadCalls: () => [...loads],
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        // The held-open SSE GET would keep close() pending
        // forever; drop the sockets explicitly.
        server.closeAllConnections();
      }),
  };
};

test("findOrLoadSession trusts live sessions; reloads after an agent restart", async () => {
  const agent1 = await startLoadCountingAgent();
  const agent2 = await startLoadCountingAgent();
  const folder = "/livetest";
  try {
    await sessionManager.registerFolder({
      path: folder,
      agentUrl: agent1.agentUrl,
      agentName: "live",
    });

    // -- 1. A just-created (still empty) session: no load --------
    const created = await sessionManager.createSession(folder, "t", "live");
    const found = await sessionManager.findOrLoadSession(folder, created.id);
    assert.ok(found, "the created session resolves");
    assert.equal(found.session.id, created.id);
    assert.ok(found.session === created, "the in-memory object is returned as-is");
    assert.equal(
      agent1.loadCalls().length,
      0,
      "no session/load for a live created session",
    );
    assert.equal(
      found.session.messages.length,
      0,
      "still empty — nothing was replayed",
    );

    // -- 2. Agent restart: new bridge URL → epoch bump → heal ---
    await sessionManager.registerFolder({
      path: folder,
      agentUrl: agent2.agentUrl,
      agentName: "live",
    });
    const healed = await sessionManager.findOrLoadSession(folder, created.id);
    assert.ok(healed, "the session resolves after the restart");
    assert.deepEqual(
      agent2.loadCalls(),
      [created.id],
      "the restarted agent reloads the empty session from disk truth",
    );
    assert.equal(
      agent1.loadCalls().length,
      0,
      "the superseded agent is never asked",
    );

    // -- 3. An empty stub from session/list still reloads --------
    await sessionManager.listSessions(folder, "live"); // hydrates stub-1
    const stub = await sessionManager.findOrLoadSession(folder, "stub-1");
    assert.ok(stub, "the stub resolves");
    assert.ok(
      agent2.loadCalls().includes("stub-1"),
      "a listed stub loads from agent truth",
    );
  } finally {
    await sessionManager.unregisterFolder(folder, "live").catch(() => {});
    await agent1.close();
    await agent2.close();
  }
});
