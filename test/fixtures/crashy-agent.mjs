// Test fixture: a healthy initialize, then dies holding a request.
//
//   initialize   → instant result
//   session/new  → instant result, and arms the crash
//   next request → the process exits instead of ever replying
//
// Used to pin the bridge's liveness contract: every held request
// is settled HTTP 502 the moment the agent child dies, instead of
// hanging until some timeout.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let armed = false;

rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === "ping") return;
  if (m.id === undefined) return;

  if (m.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "crashy-agent", version: "0.0.0" },
        agentCapabilities: {},
      },
    });
    return;
  }
  if (!armed) {
    armed = true;
    send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s-crashy" } });
    return;
  }
  // Second id-carrying request after initialize: die holding it,
  // after a beat so the POST is observably pending.
  setTimeout(() => process.exit(2), 150);
});