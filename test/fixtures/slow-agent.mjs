// Test fixture ACP agent for the long-turn bridge/transport tests.
//
// Speaks just enough JSON-RPC over stdio to sit behind the
// acp-spawn bridge:
//
//   initialize / session/new  reply instantly
//   session/prompt            streams agent_message_chunk ticks while it
//                             holds its response for SLOW_AGENT_TURN_MS,
//                             then returns end_turn — a miniature of a
//                             real long coding turn
//   anything else             thinks for SLOW_AGENT_CALL_MS, then
//                             replies {} — so clients can exercise the
//                             30s budget on plain RPCs
//
// Both durations come from the environment so tests stay fast
// while asserting real held-POST behavior.
import readline from "node:readline";

const readNum = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const TURN_MS = readNum("SLOW_AGENT_TURN_MS", 1_500);
const CALL_MS = readNum("SLOW_AGENT_CALL_MS", 0);

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = m;
  if (method === "ping") return; // bridge health probe, never forwarded
  if (id === undefined) return; // notifications: not our business

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "slow-agent", version: "0.0.0" },
        agentCapabilities: { promptCapabilities: {} },
      },
    });
    return;
  }
  if (method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId: "s-slow" } });
    return;
  }
  if (method === "session/prompt") {
    const ticks = setInterval(() => {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s-slow",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "tick" },
          },
        },
      });
    }, 100);
    setTimeout(() => {
      clearInterval(ticks);
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }, TURN_MS);
    return;
  }
  // Any other method thinks for CALL_MS before replying.
  setTimeout(() => {
    send({ jsonrpc: "2.0", id, result: {} });
  }, CALL_MS);
});