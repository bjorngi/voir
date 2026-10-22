// Manual integration check for the /api/tts WebSocket pipeline
// against a running dev server: send a speak request, expect
// binary PCM16 audio frames followed by an "end" control message.
//
//   node test/tts-roundtrip.mjs http://127.0.0.1:9000

import { WebSocket } from "ws";

const base = process.argv[2] ?? "http://127.0.0.1:9000";
const url = base.replace(/^http/, "ws") + "/api/tts";

const ws = new WebSocket(url);
let bytes = 0;
let frames = 0;
let gotEnd = false;
let errors = 0;

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "speak",
      text: "Hello there. This is a test of the neural narration pipeline.",
    }),
  );
});

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    bytes += data.length;
    frames += 1;
  } else {
    const msg = JSON.parse(String(data));
    if (msg.type === "end") gotEnd = true;
    if (msg.type === "error") errors += 1;
  }
});

setTimeout(() => {
  ws.close();
  const ok = bytes > 10000 && gotEnd && errors === 0;
  console.log(
    `audio=${bytes}B in ${frames} frames, end=${gotEnd}, errors=${errors}`,
  );
  console.log(
    ok
      ? "PASS: streamed PCM audio + end event"
      : "FAIL: no usable audio stream",
  );
  process.exit(ok ? 0 : 1);
}, 6000);

ws.on("error", (e) => {
  console.error("ws error:", e.message);
  process.exit(1);
});