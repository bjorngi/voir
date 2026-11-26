// Manual integration check for the /api/tts WebSocket pipeline
// against a running dev server: send a speak request, expect binary
// audio frames followed by an "end" control message.
//
//   node test/tts-roundtrip.mjs http://127.0.0.1:9000
//   node test/tts-roundtrip.mjs http://127.0.0.1:9000 mp3
//
// The two modes are the two client paths: linear16 (raw PCM, the
// Web Audio shape) and mp3 (a container an <audio> element can
// decode, which is what lock-screen narration uses). In mp3 mode
// the bytes must also look like MPEG audio — a frame sync (0xFFEx)
// or an ID3 tag — otherwise the element will refuse the blob.

import { WebSocket } from "ws";

const base = process.argv[2] ?? "http://127.0.0.1:9000";
const encoding = process.argv[3] === "mp3" ? "mp3" : "linear16";
const url = base.replace(/^http/, "ws") + "/api/tts";

const ws = new WebSocket(url);
let bytes = 0;
let frames = 0;
let gotEnd = false;
let errors = 0;
let head = null;

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "speak",
      text: "Hello there. This is a test of the neural narration pipeline.",
      encoding,
    }),
  );
});

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    bytes += data.length;
    frames += 1;
    if (!head) head = Buffer.from(data).subarray(0, 4);
  } else {
    const msg = JSON.parse(String(data));
    if (msg.type === "end") gotEnd = true;
    if (msg.type === "error") errors += 1;
  }
});

function looksLikeMp3(buf) {
  if (!buf || buf.length < 2) return false;
  // ID3v2 tag, or an MPEG audio frame sync (11 bits set).
  const id3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
  const sync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
  return id3 || sync;
}

setTimeout(() => {
  ws.close();
  const containerOk = encoding === "mp3" ? looksLikeMp3(head) : true;
  const ok = bytes > 10000 && gotEnd && errors === 0 && containerOk;
  console.log(
    `encoding=${encoding} audio=${bytes}B in ${frames} frames, end=${gotEnd}, errors=${errors}` +
      (encoding === "mp3" ? `, container=${containerOk ? "mp3" : "NOT AUDIO"}` : ""),
  );
  console.log(
    ok
      ? `PASS: streamed ${encoding} audio + end event`
      : "FAIL: no usable audio stream",
  );
  process.exit(ok ? 0 : 1);
}, 6000);

ws.on("error", (e) => {
  console.error("ws error:", e.message);
  process.exit(1);
});
