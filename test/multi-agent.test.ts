import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionManager } from "../app/lib/sessions.server";
import type { ChatMessage } from "../app/lib/chat-types";

// The status store persists under VOIR_DATA_DIR (docs/
// session-status.md): createSession auto-activates, which
// writes — isolate the tests' writes from the repo's dev-data.
process.env.VOIR_DATA_DIR = await mkdtemp(join(tmpdir(), "voir-multi-"));

/**
 * Multiple agents per folder path: the Phase 2 keying.
 *
 * Two acp-spawn bridges run the mock agent in the SAME worktree
 * with different names — the documented way to run, say, a fenced
 * pi and a plain pi side by side. Under test:
 *
 *   1. Both register independently (the old code replaced the
 *      first agent's client with the second).
 *   2. Sessions resolve to their owning agent by session id,
 *      even though both live under the same path.
 *   3. Turns on one agent don't disturb the other.
 *   4. Ambiguous folder-scoped calls pick the newest agent
 *      (documented) and can name their target explicitly.
 *   5. DELETE with ?name= removes only that agent.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(cond: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
}

async function startBridge(folder: string, name: string): Promise<{
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
      name,
      "--ui",
      "http://127.0.0.1:1",
      "--no-register",
    ],
    { cwd: folder, stdio: ["ignore", "pipe", "pipe"] },
  );
  const agentUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`bridge ${name} never came up`)),
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
      reject(new Error(`bridge ${name} exited before listening`)),
    );
  });
  return { child, agentUrl };
}

test("multiple agents coexist on one folder path", async () => {
  const folder = await mkdtemp(join(tmpdir(), "voir-multi-"));
  const a = await startBridge(folder, "alpha");
  const b = await startBridge(folder, "beta");
  try {
    // 1. Independent registration: both coexist.
    await sessionManager.registerFolder({
      path: folder,
      agentUrl: a.agentUrl,
      agentName: "alpha",
    });
    await sessionManager.registerFolder({
      path: folder,
      agentUrl: b.agentUrl,
      agentName: "beta",
    });
    const agents = sessionManager
      .listFolders()
      .filter((f) => f.path === folder);
    assert.equal(agents.length, 2, "both agents should be registered");
    assert.deepEqual(
      agents.map((f) => f.agentName).sort(),
      ["alpha", "beta"],
    );

    // Same agent re-registering idempotently refreshes, doesn't duplicate.
    await sessionManager.registerFolder({
      path: folder,
      agentUrl: b.agentUrl,
      agentName: "beta",
    });
    assert.equal(
      sessionManager.listFolders().filter((f) => f.path === folder).length,
      2,
    );

    // 2. Sessions created on each agent resolve back to it.
    const onAlpha = await sessionManager.createSession(
      folder,
      "alpha chat",
      "alpha",
    );
    const onBeta = await sessionManager.createSession(
      folder,
      "beta chat",
      "beta",
    );
    assert.notEqual(onAlpha.id, onBeta.id);

    const resolvedAlpha = await sessionManager.findOrLoadSession(
      folder,
      onAlpha.id,
    );
    const resolvedBeta = await sessionManager.findOrLoadSession(
      folder,
      onBeta.id,
    );
    assert.equal(resolvedAlpha?.state.agentName, "alpha");
    assert.equal(resolvedBeta?.state.agentName, "beta");

    // 3. A turn on beta doesn't touch alpha's transcript.
    await sessionManager.sendMessage(folder, onBeta.id, [
      { type: "text", text: "hello beta" },
    ]);
    assert(
      await until(
        () =>
          onBeta.inFlightPrompts === 0 &&
          !onBeta.busy &&
          onBeta.messages.length > 0,
      ),
      "beta's turn never settled",
    );
    const alphaState = await sessionManager.findOrLoadSession(
      folder,
      onAlpha.id,
    );
    assert.equal(
      alphaState?.session.messages.length,
      0,
      "alpha's transcript must be untouched by beta's turn",
    );

    // 4. Ambiguous folder-scoped create picks the newest agent
    //    (documented); the name targets it explicitly.
    const onNewest = await sessionManager.createSession(folder, "who?");
    assert.equal(
      (await sessionManager.findOrLoadSession(folder, onNewest.id))?.state
        .agentName,
      "beta",
      "unnamed create should pick the most recently registered agent",
    );
    const onNamed = await sessionManager.createSession(folder, "explicit", "alpha");
    assert.equal(
      (await sessionManager.findOrLoadSession(folder, onNamed.id))?.state
        .agentName,
      "alpha",
    );

    // getFolder without a name is honest about ambiguity.
    assert.equal(sessionManager.getFolder(folder), undefined);
    assert.equal(sessionManager.getFolder(folder, "alpha")?.agentName, "alpha");

    // 5. Unregistering one agent leaves the other fully intact.
    await sessionManager.unregisterFolder(folder, "alpha");
    const remaining = sessionManager
      .listFolders()
      .filter((f) => f.path === folder);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].agentName, "beta");

    // beta's session still resolves and is still usable.
    const betaAfter = await sessionManager.findOrLoadSession(
      folder,
      onBeta.id,
    );
    assert.ok(betaAfter, "beta's session should survive alpha's removal");
    await sessionManager.sendMessage(folder, onBeta.id, [
      { type: "text", text: "still here" },
    ]);
    assert(
      await until(() => onBeta.inFlightPrompts === 0 && !onBeta.busy),
      "beta's turn after alpha removal never settled",
    );

    // Ambiguous DELETE without a name must refuse rather than guess.
    await sessionManager.registerFolder({
      path: folder,
      agentUrl: a.agentUrl,
      agentName: "alpha",
    });
    await assert.rejects(
      sessionManager.unregisterFolder(folder),
      /several agents.*alpha, beta|alpha.*beta/s,
    );
  } finally {
    await sessionManager.unregisterFolder(folder, "alpha").catch(() => {});
    await sessionManager.unregisterFolder(folder, "beta").catch(() => {});
    a.child.kill("SIGTERM");
    b.child.kill("SIGTERM");
  }
});