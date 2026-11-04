import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sessionManager,
  folderSummary,
} from "../app/lib/sessions.server";
import { saveUpload, flushUploadsForTest } from "../app/lib/uploads.server";
import { modelVision } from "../app/lib/chat-types";
import { imageWireBlocks } from "../app/lib/composer-payload";
import { until } from "./helpers/bridge";

// Isolate the stores (uploads + session status both persist).
process.env.VOIR_DATA_DIR = await mkdtemp(join(tmpdir(), "voir-images-"));

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// 1×1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function startBridge(folder: string, fixture: string): Promise<{
  child: ChildProcess;
  agentUrl: string;
}> {
  const child = spawn(
    process.execPath,
    [
      join(ROOT, "bin/acp-spawn.mjs"),
      "--agent",
      `node ${join(ROOT, fixture)}`,
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

/**
 * Images end to end on a real acp-spawn bridge running the mock
 * agent (which advertises promptCapabilities.image and counts
 * the image blocks it receives):
 *
 *   1. The initialize handshake carries promptCapabilities into
 *      FolderState and folderSummary (the composer's paperclip
 *      gate).
 *   2. A prompt with an image + marker renders as a user message
 *      with thumbnails attached and the marker stripped from
 *      display text.
 *   3. The agent received the image content block (the mock's
 *      echo counts it).
 *   4. A resync (clearAgentCaches — the drawer's Clear cache)
 *      replays the session from agent truth: the user message
 *      comes back through user_message_chunk with the marker in
 *      the text, and the replay path re-attaches the same
 *      thumbnails — live and replayed transcripts are identical.
 *   5. An agent that never advertised image capabilities
 *      reports image: false in its summary (paperclip hidden).
 */
test("images: capability, live attach, agent receipt, replay re-attach", async () => {
  const folder = await mkdtemp(join(tmpdir(), "voir-images-e2e-"));
  const { child, agentUrl } = await startBridge(folder, "bin/mock-acp.mjs");
  try {
    await sessionManager.registerFolder({
      path: folder,
      agentUrl,
      agentName: "it",
    });
    const state = sessionManager.getFolder(folder, "it")!;

    // -- 1. Capability plumbing -----------------------------------
    assert.equal(
      state.promptCapabilities?.image,
      true,
      "initialize's promptCapabilities landed on FolderState",
    );
    assert.equal(
      folderSummary(state).image,
      true,
      "folderSummary exposes the gate flag",
    );

    // -- 2. Live send with an image --------------------------------
    const upload = await saveUpload(PNG, "image/png", "dot.png");
    assert.ok(upload, "upload staged");
    const session = await sessionManager.createSession(folder, "images it");
    // Per-model vision (tri-state, docs/images-and-share.md):
    // session/new refreshes availableModels; the mock advertises
    // _meta.piAcp.input (the pi-acp voir-patch convention) —
    // cheery vision, cryptic text-only.
    assert.equal(
      state.availableModels.length,
      2,
      "session/new models passthrough",
    );
    assert.equal(
      modelVision(state.availableModels[0]),
      true,
      "cheery-1 is vision-capable via _meta",
    );
    assert.equal(
      modelVision(state.availableModels[1]),
      false,
      "cryptic-2 is text-only via _meta",
    );
    assert.equal(
      modelVision({ modelId: "none" }),
      undefined,
      "agents without the meta are unknown (no warning, no claim)",
    );
    await sessionManager.sendMessage(folder, session.id, [
      { type: "text", text: "what is this" },
      ...imageWireBlocks({
        id: upload.id,
        mimeType: "image/png",
        data: PNG.toString("base64"),
      }),
    ]);

    const user = session.messages.find(
      (m) => m.role === "user" && m.kind === "text",
    )! as { text: string; images?: Array<{ id: string; name?: string }> };
    assert.equal(user.text, "what is this", "marker stripped from display");
    assert.equal(user.images?.length, 1, "image attached to the message");
    assert.equal(user.images![0].id, upload.id);
    assert.equal(user.images![0].name, "dot.png");

    // -- 3. The agent received the image ---------------------------
    assert(
      await until(() =>
        session.inFlightPrompts === 0 &&
        !session.busy &&
        session.messages.some(
          (m) =>
            m.role === "agent" &&
            m.kind === "thought" &&
            /1 image/.test(m.text ?? ""),
        ),
      ),
      "turn never settled / image never echoed",
    );

    // -- 4. Replay re-attaches from the marker ---------------------
    const cleared = sessionManager.clearAgentCaches(folder, {
      sessionId: session.id,
    });
    assert.ok(cleared, "cache clear resolved the agent");
    assert(
      await until(
        () =>
          session.messages.filter((m) => m.role === "user" && m.kind === "text")
            .length >= 1 &&
          (() => {
            const replayed = session.messages.find(
              (m) =>
                m.role === "user" &&
                m.kind === "text" &&
                (m.text === "what is this" || m.text.includes("[Image:")),
            ) as
              | { text: string; images?: Array<{ id: string }> }
              | undefined;
            return !!replayed?.images?.some((i) => i.id === upload.id);
          })(),
      ),
      "replay never re-attached the image",
    );
    const replayedUser = session.messages.find(
      (m) => m.role === "user" && m.kind === "text",
    )! as { text: string; images?: Array<{ id: string }> };
    assert.equal(replayedUser.text, "what is this", "replayed display text");
    assert.ok(
      replayedUser.images?.some((i) => i.id === upload.id),
      "replayed message carries the thumbnail ref",
    );
    await flushUploadsForTest();
  } finally {
    await sessionManager.unregisterFolder(folder, "it").catch(() => {});
    child?.kill("SIGTERM");
  }
});

test("images: an agent without the capability reports image: false", async () => {
  const folder = await mkdtemp(join(tmpdir(), "voir-images-off-"));
  // slow-agent advertises promptCapabilities: {} — no image.
  const { child, agentUrl } = await startBridge(
    folder,
    "test/fixtures/slow-agent.mjs",
  );
  try {
    await sessionManager.registerFolder({
      path: folder,
      agentUrl,
      agentName: "it",
    });
    const state = sessionManager.getFolder(folder, "it")!;
    assert.equal(state.promptCapabilities?.image, undefined);
    assert.equal(
      folderSummary(state).image,
      false,
      "paperclip gate closed for non-image agents",
    );
  } finally {
    await sessionManager.unregisterFolder(folder, "it").catch(() => {});
    child?.kill("SIGTERM");
  }
});