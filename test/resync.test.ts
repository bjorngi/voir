import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionManager } from "../app/lib/sessions.server";
import type { ChatMessage } from "../app/lib/chat-types";

/**
 * End-to-end resync test: a real acp-spawn bridge running the
 * mock agent, with --sse-lifetime forcing the SSE leg to drop
 * every 400ms (simulating proxy cuts / network blips). The
 * contract under test:
 *
 *   1. The transport reopens the stream by itself (no page
 *      reload, no re-registration).
 *   2. onReconnect fires in the session manager → resyncFolder.
 *   3. resync replays every held session from agent truth via
 *      session/load, so in-memory state that diverged while the
 *      leg was down is replaced wholesale.
 *   4. Live listeners get a `resync` control message asking them
 *      to re-snapshot.
 *
 * "Diverged while down" is simulated by injecting a bogus message
 * into the in-memory transcript after the turn settles: if resync
 * replays from the agent, the marker must disappear.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url)); // unused, keep tree readable

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

test("resync: dropped agent stream heals and replays from agent truth", async () => {
  const folder = await mkdtemp(join(tmpdir(), "voir-resync-"));
  let child: ChildProcess | null = null;
  try {
    child = spawn(
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
        "--sse-lifetime",
        "400",
      ],
      { cwd: folder, stdio: ["ignore", "pipe", "pipe"] },
    );

    // The bridge logs "… bridge for <folder> on http://…/" once
    // it is listening; that URL is what we register.
    const agentUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("bridge never came up")),
        10_000,
      );
      child!.stdout!.on("data", (b: Buffer) => {
        const m = b.toString().match(/on (http:\/\/\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child!.on("exit", () =>
        reject(new Error("acp-spawn exited before listening")),
      );
    });

    await sessionManager.registerFolder({
      path: folder,
      agentUrl,
      agentName: "it",
    });
    const session = await sessionManager.createSession(folder, "resync it");
    assert.ok(session, "session created");

    const resyncs: ChatMessage[] = [];
    const unsub = sessionManager.subscribe(session.id, (msg) => {
      if (msg.role === "system" && msg.kind === "control") {
        const c = (msg as { control?: { type?: string } }).control;
        if (c?.type === "resync") resyncs.push(msg);
      }
    });

    // Run a turn. The reply may or may not arrive over the flaky
    // stream — that is the point; resync must make the transcript
    // whole regardless.
    await sessionManager.sendMessage(folder, session.id, [
      { type: "text", text: "hello" },
    ]);
    assert(
      await until(() => session.inFlightPrompts === 0 && !session.busy),
      "turn never settled",
    );

    // Simulate divergence: a message the agent never produced,
    // e.g. updates missed while the leg was down.
    session.messages.push({
      id: "bogus",
      role: "user",
      kind: "text",
      text: "BOGUS",
      at: Date.now(),
    });

    // The stream drops every 400ms; the transport must reopen on
    // its own, fire onReconnect, and the resync must replay every
    // held session from agent truth — wiping the bogus message.
    // Require a fully-replayed transcript (not just "marker gone",
    // which is also true mid-replay while messages is cleared) so
    // we don't assert inside a replay window.
    assert(
      await until(
        () =>
          resyncs.length >= 1 &&
          session.messages.length >= 2 &&
          !session.messages.some((m) => m.id === "bogus"),
      ),
      "resync never replayed the session",
    );

    // After replay, the transcript must contain the real turn
    // (user message + agent reply), proving the rebuild came
    // from agent truth and not from a wipe.
    assert.ok(
      session.messages.some(
        (m) => m.role === "agent" && m.kind === "text" && m.text,
      ),
      "agent reply missing after resync",
    );
    assert.ok(
      session.messages.some(
        (m) => m.role === "user" && m.kind === "text" && m.text?.includes("hello"),
      ),
      "user message missing after resync",
    );

    unsub();
  } finally {
    await sessionManager.unregisterFolder(folder).catch(() => {});
    child?.kill("SIGTERM");
  }
});