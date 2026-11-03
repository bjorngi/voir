// Test fixture: a quiet agent for exercising Voir's busy inference.
//
// It never emits anything on its own. Tests drive it by POSTing
// `test/inject` notifications through the bridge:
//
//   { jsonrpc: "2.0", method: "test/inject",
//     params: { sessionId, update } }   (no id → bridge 204s it)
//
// The fixture re-emits the params verbatim as a real
// `session/update` notification, so a test can fire arbitrary
// out-of-turn updates — the pi-acp-shaped `_meta.piAcp.running`
// idle signal included — without ever sending a session/prompt.
import readline from "node:readline";
import { randomUUID } from "node:crypto";

// A unique session id per run: tests can register several of these
// agents against one sessionManager, and Voir routes updates by
// sessionId — ids colliding across folders would cross-wire them.
const SESSION_ID = randomUUID();

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = m;
  if (method === "ping") return;

  if (id === undefined) {
    if (method === "test/inject") {
      send({ jsonrpc: "2.0", method: "session/update", params });
    }
    return;
  }
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "manual-agent", version: "0.0.0" },
        agentCapabilities: {},
      },
    });
    return;
  }
  if (method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId: SESSION_ID } });
    return;
  }
  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `not implemented: ${method}` },
  });
});