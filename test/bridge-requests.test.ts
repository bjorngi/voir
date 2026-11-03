import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  postRpc,
  sleep,
  spawnBridge,
  until,
  type Bridge,
} from "./helpers/bridge";

/**
 * Bridge-level liveness contract (bin/acp-lib.mjs), driven against
 * a real acp-spawn bridge:
 *
 *   1. A held `session/prompt` is answered with the agent's real
 *      response — however long the turn takes. The old
 *      implementation raced every request against a hardcoded 30s
 *      timeout and 504'd mid-turn: Voir flipped to not-busy (the
 *      loading bar and Stop button vanished) while the agent kept
 *      streaming, and the turn's real result was dropped. A 30s
 *      turn would be too slow for the suite, so these tests hold
 *      ~1.5s — the boundary itself is covered by construction:
 *      the request path contains no `setTimeout` race anymore.
 *   2. Notifications stream over SSE the whole time the POST is
 *      held — the exact surface that made "agent working, no
 *      spinner" visible.
 *   3. When the agent child dies, every held request is settled
 *      HTTP 502 immediately instead of hanging.
 */

// Turn length for the slow fixture (this file's spawn).
process.env.SLOW_AGENT_TURN_MS = "1500";

test("bridge holds session/prompt open for the whole turn", async () => {
  const folder = await mkdtemp(join(tmpdir(), "voir-bridge-hold-"));
  const bridge: Bridge | undefined = await spawnBridge(
    folder,
    "slow-agent.mjs",
    "slow",
  ).catch(() => undefined);
  assert.ok(bridge, "bridge came up");
  const { child, agentUrl } = bridge;
  try {
    // Open the SSE leg first: the notification stream must deliver
    // chunks while the POST is held.
    const sse = await fetch(agentUrl, {
      headers: { Accept: "text/event-stream" },
    });
    assert.equal(sse.headers.get("content-type"), "text/event-stream");
    const sseChunks: string[] = [];
    const reader = sse.body!.getReader();
    const readLoop = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sseChunks.push(dec.decode(value));
      }
    })().catch(() => {});

    const init = await postRpc(agentUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    assert.equal(init.status, 200);
    const created = await postRpc(agentUrl, {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: folder, mcpServers: [] },
    });
    assert.equal(created.status, 200);

    const t0 = Date.now();
    const turn = await postRpc(agentUrl, {
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: "s-slow",
        prompt: [{ type: "text", text: "go" }],
      },
    });
    const elapsed = Date.now() - t0;

    assert.equal(turn.status, 200, "long turn must be 200, not a 504");
    assert.ok(elapsed >= 1_400, `turn held ${elapsed}ms`);
    const body = await turn.json();
    assert.equal(body?.result?.stopReason, "end_turn");

    // The turn streamed on the SSE leg the whole time.
    assert(
      await until(() => sseChunks.join("").includes("agent_message_chunk")),
      "no chunks streamed while the POST was held",
    );

    reader.cancel().catch(() => {});
    await readLoop;
  } finally {
    child.kill("SIGTERM");
  }
});

test("bridge settles pending requests 502 when the agent child dies", async () => {
  const folder = await mkdtemp(join(tmpdir(), "voir-bridge-exit-"));
  const bridge = await spawnBridge(folder, "crashy-agent.mjs", "crashy");
  assert.ok(bridge, "bridge came up");
  const { child, agentUrl } = bridge;
  try {
    const init = await postRpc(agentUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    assert.equal(init.status, 200);
    // session/new arms the crash in the fixture.
    const created = await postRpc(agentUrl, {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: folder, mcpServers: [] },
    });
    assert.equal(created.status, 200);

    await sleep(100); // let the framing loop settle
    const t0 = Date.now();
    const res = await postRpc(agentUrl, {
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_mode",
      params: { sessionId: "s-crashy", modeId: "x" },
    });
    const elapsed = Date.now() - t0;

    assert.equal(res.status, 502, "child death must settle pending as 502");
    assert.ok(elapsed < 5_000, `settled in ${elapsed}ms — must not hang`);
  } finally {
    child.kill("SIGTERM");
  }
});