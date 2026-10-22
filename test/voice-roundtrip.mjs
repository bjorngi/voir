// Manual integration check for the /api/voice WebSocket pipeline
// against a running dev server. Simulates what the browser does:
// start message, synthetic PCM16 audio (speech bursts + silence),
// and verifies the normalized events stream back.
//
//   node test/voice-roundtrip.mjs http://127.0.0.1:9000
//
// Speech is synthesized as a 220Hz square wave — enough energy for
// the mock's segmenter, and it doubles as a quick check that the
// frame math on the server is right.

const base = process.argv[2] ?? "http://127.0.0.1:9000";
const url = base.replace(/^http/, "ws") + "/api/voice";

const { WebSocket } = await import("ws");
const ws = new WebSocket(url);
const events = [];
const PCM_RATE = 24000;

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "start", language: navigatorish() }));
  // talk 600ms, pause 1200ms (triggers utterance_end at ~700ms),
  // talk again briefly, then stop cleanly.
  sendTone(600);
  setTimeout(() => sendSilence(1200), 600);
  setTimeout(() => {
    sendTone(300);
    setTimeout(() => {
      ws.send(JSON.stringify({ type: "stop" }));
      setTimeout(() => ws.close(), 500);
    }, 300);
  }, 1800);
});

ws.on("message", (data) => {
  events.push(JSON.parse(String(data)));
});

ws.on("close", () => {
  const kinds = events.map((e) => e.type);
  const interims = events.filter((e) => e.type === "interim");
  const finals = events.filter((e) => e.type === "final");
  const ends = events.filter((e) => e.type === "utterance_end");
  const errors = events.filter((e) => e.type === "error");
  console.log("events:", kinds.join(", "));
  const ok =
    interims.length > 0 &&
    finals.length >= 1 &&
    ends.length >= 1 &&
    errors.length === 0;
  console.log(
    ok ? "PASS: interim/final/utterance_end all received" : "FAIL",
  );
  if (finals[0]) console.log("final transcript:", JSON.stringify(finals[0].text));
  process.exit(ok ? 0 : 1);
});

ws.on("error", (e) => {
  console.error("ws error:", e.message);
  process.exit(1);
});

function navigatorish() {
  return "en-US";
}

function sendTone(ms) {
  const frames = Math.floor((PCM_RATE * ms) / 1000);
  const pcm = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    pcm[i] = Math.sin((2 * Math.PI * 220 * i) / PCM_RATE) > 0 ? 12000 : -12000;
  }
  // send in 40ms chunks like the worklet does
  const chunk = 960;
  for (let i = 0; i < pcm.length; i += chunk) {
    ws.send(pcm.slice(i, i + chunk).buffer);
  }
}

function sendSilence(ms) {
  const frames = Math.floor((PCM_RATE * ms) / 1000);
  const chunk = 960;
  let sent = 0;
  const timer = setInterval(() => {
    if (sent >= frames) return clearInterval(timer);
    ws.send(new Int16Array(Math.min(chunk, frames - sent)).buffer);
    sent += chunk;
  }, 40);
}