import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionManager } from "../app/lib/sessions.server";
import { extractFenced, matchFenced } from "../app/lib/render/registry";
import { until } from "./helpers/bridge";

// Rich-content survives REPLAY (the refresh / resync path):
// a live turn coalesces its stream into one message and the
// fences are whole; a voir restart (or agent-leg resync) rebuilds
// the transcript from the agent's replay — which arrives as
// PIECEWISE chunks. Regression being fixed (2026-11-04): the
// replay path shredded each chunk into its own message (fences
// split → no module matched) and could leave the last message's
// streaming flag stuck true (the settle gate never lifted).

process.env.VOIR_DATA_DIR = await mkdtemp(join(tmpdir(), "voir-rich-replay-"));

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
    child.on("exit", () => reject(new Error("bridge exited before listening")));
  });
  return { child, agentUrl };
}

test("rich blocks survive replay: coalesced chunks, settled flag, matchable fences", async () => {
  const folder = await mkdtemp(join(tmpdir(), "voir-rich-replay-e2e-"));
  const { child, agentUrl } = await startBridge(folder);
  try {
    await sessionManager.registerFolder({
      path: folder,
      agentUrl,
      agentName: "it",
    });
    const session = await sessionManager.createSession(folder, "rich replay");

    // -- the live turn: "rich" emits the demo blocks ---------------
    await sessionManager.sendMessage(folder, session.id, [
      { type: "text", text: "rich" },
    ]);
    assert(
      await until(
        () =>
          session.inFlightPrompts === 0 &&
          !session.busy &&
          session.messages.some(
            (m) => m.role === "agent" && m.kind === "text" && (m.text ?? "").includes("voir-card"),
          ),
      ),
      "live turn never settled / demo never arrived",
    );
    // Live sanity: fences whole + last agent text settled.
    const liveTexts = session.messages.filter(
      (m) => m.role === "agent" && m.kind === "text",
    ) as Array<{ text: string; streaming?: boolean; id: string }>;
    const liveLast = liveTexts[liveTexts.length - 1];
    assert.equal(liveLast.streaming ?? false, false, "live final settled");
    assert.ok(
      matchFenced("voir-card", extractFenced(liveLast.text).find((b) => b.lang === "voir-card")!.body, false),
      "live text contains a matchable card",
    );

    // -- the replay path: drop the caches → session/load replay ----
    const cleared = sessionManager.clearAgentCaches(folder, { sessionId: session.id });
    assert.ok(cleared, "cache clear resolved the agent");
    assert(
      await until(() => {
        const texts = session.messages.filter(
          (m) => m.role === "agent" && m.kind === "text",
        ) as Array<{ text: string; streaming?: boolean; id: string }>;
        const last = texts[texts.length - 1];
        return (
          texts.length >= 1 &&
          (last?.streaming ?? false) === false &&
          (last?.text ?? "").includes("voir-card")
        );
      }),
      "replay never rebuilt a settled, fence-whole transcript",
    );

    // The coalescing regression: the replay must NOT shard the
    // message stream (the mock replays the recorded 30-char
    // chunks; before the fix each chunk became its own message).
    const texts = session.messages.filter(
      (m) => m.role === "agent" && m.kind === "text",
    ) as Array<{ text: string; streaming?: boolean }>;
    assert.ok(
      texts.length <= liveTexts.length + 1,
      `replay shredded the message stream: ${texts.length} vs live ${liveTexts.length}`,
    );

    // The fenced blocks in the replayed transcript match modules.
    const blockCount = extractFenced(
      texts.map((t) => t.text).join("\n"),
    ).filter((b) => matchFenced(b.lang, b.body, false) !== null).length;
    assert.ok(blockCount >= 5, `rich blocks matchable: ${blockCount}`);
  } finally {
    await sessionManager.unregisterFolder(folder, "it").catch(() => {});
    child?.kill("SIGTERM");
  }
});