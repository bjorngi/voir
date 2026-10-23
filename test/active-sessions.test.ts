import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionManager, folderSummary, activityOf, activeSnapshot } from "../app/lib/sessions.server";
import { sessionStatusStore } from "../app/lib/session-status.server";
import { loader, action } from "../app/routes/api.session-status";

/**
 * End-to-end session-status wiring (docs/session-status.md) on a
 * real acp-spawn bridge running the mock agent. The contract
 * under test:
 *
 *   1. Auto-activation: createSession and sendMessage write
 *      "active" (the shortlist maintains itself); prompting an
 *      unmarked session re-activates it.
 *   2. The overlay: folderSummary stamps the status; absence =
 *      the pile.
 *   3. Stubs: listSessions hydrates the mock's seeded sessions
 *      with stub: true (activity "idle"); loading clears the
 *      flag and reports from the replayed transcript.
 *   4. The snapshot: rows carry the derived live state,
 *      working sorts first, unresolvable entries are skipped.
 *   5. Prune wiring: a store entry the agent doesn't list dies
 *      at the next listSessions; real sessions survive.
 *   6. The API: POST validates and transitions; GET serves the
 *      snapshot.
 */

// Isolate the store's writes from the repo's dev-data — must be
// set before the first store access (the singleton resolves
// VOIR_DATA_DIR lazily on first use, so import-time is safe).
process.env.VOIR_DATA_DIR = await mkdtemp(join(tmpdir(), "voir-active-"));

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(cond: () => boolean, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
}

async function startBridge(folder: string): Promise<{
  child: ChildProcess;
  agentUrl: string;
}> {
  const child = spawn(
    process.execPath,
    [
      join(ROOT, "bin/acp-spawn.mjs"),
      "--agent",
      `node ${join(ROOT, "bin/mock-acp.mjs")}`,
      "--name",
      "it",
      "--ui",
      "http://127.0.0.1:1",
      "--no-register",
    ],
    { cwd: folder, stdio: ["ignore", "pipe", "pipe"] },
  );
  const agentUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("bridge never came up")),
      10_000,
    );
    child.stdout!.on("data", (b: Buffer) => {
      const m = b.toString().match(/on (http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on("exit", () =>
      reject(new Error("bridge exited before listening")),
    );
  });
  return { child, agentUrl };
}

function postRequest(body: unknown): Request {
  return new Request("http://voir.test/api/session-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("active sessions: auto-activation, overlay, stubs, snapshot, prune, API", async () => {
  const folder = await mkdtemp(join(tmpdir(), "voir-active-e2e-"));
  const { child, agentUrl } = await startBridge(folder);
  try {
    await sessionManager.registerFolder({
      path: folder,
      agentUrl,
      agentName: "it",
    });
    const state = sessionManager.getFolder(folder, "it")!;

    // -- 1. Auto-activation ------------------------------------------
    const session = await sessionManager.createSession(
      folder,
      "auto test",
      "it",
    );
    assert.equal(
      sessionStatusStore.getStatus(folder, session.id),
      "active",
      "createSession marks the new chat active",
    );

    // -- 2. The overlay ----------------------------------------------
    // Hydrate the agent's seeded sessions first (the loader's
    // listSessions pass) so stubs exist.
    await sessionManager.listSessions(folder);
    const summary = folderSummary(state);
    const own = summary.sessions.find((s) => s.id === session.id);
    assert.equal(own?.status, "active");
    const seeded = summary.sessions.find((s) => s.id.startsWith("seed-"));
    const seededOther = summary.sessions.find(
      (s) => s.id.startsWith("seed-") && s.id !== seeded?.id,
    );
    assert.ok(seeded, "the mock agent seeds sessions");
    assert.ok(seededOther, "the mock agent seeds several sessions");
    assert.equal(seeded?.status, undefined, "stubs are the pile by default");

    // -- 3. Stubs ----------------------------------------------------
    const stub = state.sessions.get(seeded!.id)!;
    assert.equal(stub.stub, true, "listSessions hydrates stubs");
    assert.equal(activityOf(state, stub).state, "idle");
    const loaded = await sessionManager.findOrLoadSession(
      folder,
      seeded!.id,
      "it",
    );
    assert.ok(loaded);
    assert.notEqual(loaded.session.stub, true, "load clears the stub flag");
    assert.equal(
      activityOf(loaded.state, loaded.session).state,
      "waiting",
      "seeded history replays into a waiting session",
    );

    // -- 4. Prompting re-activates and the state goes working --------
    sessionStatusStore.setStatus(folder, session.id, "none");
    assert.equal(sessionStatusStore.getStatus(folder, session.id), undefined);
    sessionManager.sendMessage(folder, session.id, [
      { type: "text", text: "hello" },
    ]);
    assert.equal(
      sessionStatusStore.getStatus(folder, session.id),
      "active",
      "sendMessage re-activates",
    );
    const held = sessionManager.getSession(folder, session.id)!;
    assert.equal(held.busy, true, "busy is set synchronously");
    assert.equal(activityOf(state, held).state, "working");

    // Snapshot while the turn is in flight: the working row sorts
    // first; the (still unloaded) seeded stub we mark below
    // stays below it.
    sessionStatusStore.setStatus(folder, seededOther!.id, "active");
    let rows = await activeSnapshot();
    assert.equal(rows[0].sessionId, session.id);
    assert.equal(rows[0].state, "working");
    assert.equal(rows[0].folder, folder);
    assert.equal(rows[0].title, "auto test");
    assert.equal(
      rows.find((r) => r.sessionId === seededOther!.id)?.state,
      "idle",
      "an active stub that was never loaded reports idle",
    );

    // The turn settles → waiting.
    assert.ok(
      await until(() => !sessionManager.getSession(folder, session.id)!.busy),
      "the mock's turn completes",
    );
    rows = await activeSnapshot();
    assert.equal(
      rows.find((r) => r.sessionId === session.id)?.state,
      "waiting",
    );

    // Entries that can't resolve are skipped, not fabricated.
    sessionStatusStore.setStatus("/nowhere-registered", "s-x", "active");
    rows = await activeSnapshot();
    assert.ok(
      !rows.some((r) => r.folder === "/nowhere-registered"),
      "unresolvable entries are skipped",
    );

    // -- 6. The API ---------------------------------------------------
    const badWord = (await action({
      request: postRequest({ folder, sessionId: session.id, status: "done" }),
    } as Parameters<typeof action>[0])) as Response;
    assert.equal(badWord.status, 400, "rejected status words");

    const unknownSession = (await action({
      request: postRequest({ folder, sessionId: "nope", status: "active" }),
    } as Parameters<typeof action>[0])) as Response;
    assert.equal(unknownSession.status, 404, "unknown folder/session");

    const unknownFolder = (await action({
      request: postRequest({ folder: "/never", sessionId: "x", status: "active" }),
    } as Parameters<typeof action>[0])) as Response;
    assert.equal(unknownFolder.status, 404, "unknown folder");

    const archive = (await action({
      request: postRequest({ folder, sessionId: session.id, status: "archived" }),
    } as Parameters<typeof action>[0])) as Response;
    assert.equal(archive.status, 200);
    assert.equal(sessionStatusStore.getStatus(folder, session.id), "archived");

    const unarchive = (await action({
      request: postRequest({ folder, sessionId: session.id, status: "none" }),
    } as Parameters<typeof action>[0])) as Response;
    assert.equal(unarchive.status, 200);
    assert.equal(sessionStatusStore.getStatus(folder, session.id), undefined);

    // GET serves the same snapshot.
    const snapshot = await loader();
    assert.ok(Array.isArray(snapshot.sessions));
    assert.ok(
      snapshot.sessions.every((r) => "state" in r && "lastActivityAt" in r),
    );

    // -- 5. Prune wiring ---------------------------------------------
    sessionStatusStore.setStatus(folder, "ghost-id", "active");
    sessionStatusStore.setStatus(folder, session.id, "active");
    await sessionManager.listSessions(folder);
    assert.equal(
      sessionStatusStore.getStatus(folder, "ghost-id"),
      undefined,
      "an entry the agent doesn't list is pruned",
    );
    assert.equal(
      sessionStatusStore.getStatus(folder, session.id),
      "active",
      "sessions the agent listed survive",
    );
    // The archived word follows the same rule.
    sessionStatusStore.setStatus(folder, "ghost-archived", "archived");
    await sessionManager.listSessions(folder);
    assert.equal(sessionStatusStore.getStatus(folder, "ghost-archived"), undefined);
    await sessionStatusStore.flush();
  } finally {
    child.kill();
    await sessionManager.unregisterFolder(folder, "it");
  }
});