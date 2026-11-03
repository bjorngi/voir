import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  postRpc,
  sleep,
  spawnBridge,
  type Bridge,
} from "./helpers/bridge";
import {
  HttpJsonRpcTransport,
  type JsonRpcMessage,
} from "../app/lib/acp-client.server";

/**
 * Client-leg timeout policy (app/lib/acp-client.server.ts):
 *
 *   - plain RPCs keep a 30s budget so a wedged agent fails fast —
 *     here overridden to 300ms via ACP_REQUEST_TIMEOUT_MS to keep
 *     the test fast;
 *   - `session/prompt` and `session/load` must NEVER time out on
 *     the client leg: the bridge holds them for the whole turn.
 *     (fetch()/undici enforced a ~300s headers timeout instead —
 *     a silent ceiling for real turns — which is why send() speaks
 *     node:http.)
 */

const rpc = (id: number, method: string, params?: unknown): JsonRpcMessage =>
  ({ jsonrpc: "2.0", id, method, params }) as JsonRpcMessage;

test("non-prompt RPCs time out fast; the prompt and load legs never do", async () => {
  const folder = await mkdtemp(join(tmpdir(), "voir-transport-"));
  process.env.ACP_REQUEST_TIMEOUT_MS = "300";
  process.env.SLOW_AGENT_CALL_MS = "800";
  process.env.SLOW_AGENT_TURN_MS = "800";

  const bridge: Bridge = await spawnBridge(folder, "slow-agent.mjs", "slow");
  const { child, agentUrl } = bridge;
  const transport = new HttpJsonRpcTransport(agentUrl);
  try {
    const init = await transport.send(
      rpc(1, "initialize", { protocolVersion: 1, clientCapabilities: {} }),
    );
    assert.ok(init?.result, "initialize answered");

    const created = (await transport.send(
      rpc(2, "session/new", { cwd: folder, mcpServers: [] }),
    ))?.result as { sessionId?: string };
    assert.ok(created?.sessionId, "session/new answered");

    // A plain RPC slower than the budget fails fast…
    await assert.rejects(
      transport.send(rpc(3, "session/set_mode", { sessionId: "s-slow", modeId: "x" })),
      /timed out/,
    );

    // …while the prompt leg, exempt from any client timeout, holds
    // long past the 300ms budget and lands with its real result.
    const t0 = Date.now();
    const turn = (await transport.send(
      rpc(4, "session/prompt", {
        sessionId: "s-slow",
        prompt: [{ type: "text", text: "go" }],
      }),
    ))?.result as { stopReason?: string };
    const elapsed = Date.now() - t0;
    assert.equal(turn?.stopReason, "end_turn");
    assert.ok(elapsed >= 700, `prompt held ${elapsed}ms despite timeout budget`);

    // session/load is equally exempt (the fixture slow-paths it).
    const loaded = await transport.send(
      rpc(5, "session/load", { sessionId: "s-slow", cwd: folder, mcpServers: [] }),
    );
    assert.ok(loaded?.result !== undefined, "session/load answered past budget");
  } finally {
    transport.close();
    child.kill("SIGTERM");
  }
});