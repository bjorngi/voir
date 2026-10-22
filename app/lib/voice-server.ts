import { WebSocket, WebSocketServer } from "ws";
import { rmsOfInt16, UtteranceSegmenter } from "./voice-segmenter";

/**
 * Voice conversation mode — server side.
 *
 * The browser streams raw mic audio (16-bit PCM, 24kHz, mono)
 * over a WebSocket at /api/voice; this module relays it to a
 * speech-to-text provider and relays normalized transcript events
 * back. The API key lives in the server's environment — the
 * browser never sees it.
 *
 * Normalized events sent to the client (JSON text frames):
 *
 *   { "type": "interim", "text": "…" }    — replace the live preview
 *   { "type": "final",   "text": "…" }    — append to the settled draft
 *   { "type": "utterance_end" }           — the speaker paused; the
 *                                          draft is a complete turn
 *   { "type": "error",    "message": "…" }
 *
 * Messages from the client:
 *
 *   binary frames                          — PCM16 audio
 *   { "type": "start", "language": "nb" } — open a provider session
 *   { "type": "stop" }                    — flush and close
 *
 * Providers (VOICE_STT_PROVIDER):
 *
 *   mock      — no key. Energy-based segmentation via
 *               voice-segmenter; emits canned phrases as if they
 *               were transcribed, streamed word-by-word. The whole
 *               conversation loop can be developed and demoed with
 *               zero credentials (docker compose uses this).
 *   deepgram  — Nova streaming STT over their WebSocket: interim
 *               results, smart formatting, and their VAD drives
 *               utterance_end. Needs VOICE_STT_API_KEY.
 *
 * NOTE: this attaches to the Vite dev server's HTTP server (see
 * vite.config.ts). React-router-serve (the production entry) has
 * no WebSocket story yet — voice mode is dev-server-only for now.
 */

// ---------------------------------------------------------------------
// Client-facing event types
// ---------------------------------------------------------------------

type ToClient =
  | { type: "interim"; text: string }
  | { type: "final"; text: string }
  | { type: "utterance_end" }
  | { type: "error"; message: string };

interface SttProvider {
  /** Called with client JSON control messages. */
  control(msg: unknown): void;
  /** Called with client audio (PCM16 little-endian mono 24kHz). */
  audio(chunk: Buffer): void;
  /** Graceful stop: flush any pending result. */
  stop(): void;
  /** Close provider resources. */
  close(): void;
}

type Emit = (ev: ToClient) => void;

// ---------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------

const MOCK_PHRASES = [
  "hey, can you take a look at the failing tests in the auth module?",
  "add a health endpoint and write a couple of tests for it.",
  "actually, scratch that — let's refactor the session manager first.",
  "please summarize what changed in the worktree since yesterday.",
];

const MOCK_FRAME_MS = 10;
const MOCK_VOICE_RMS = 0.015;

class MockProvider implements SttProvider {
  private seg = new UtteranceSegmenter({
    frameMs: MOCK_FRAME_MS,
    speechRms: MOCK_VOICE_RMS,
    silenceMs: 700,
  });
  private buf: Buffer = Buffer.alloc(0);
  private words: string[] = [];
  private spokenWords = 0;
  private voicedFrames = 0;
  private phraseIdx = 0;
  private done = false;

  constructor(private emit: Emit) {}

  control() {}

  audio(chunk: Buffer) {
    if (this.done) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frameBytes = ((24000 * MOCK_FRAME_MS) / 1000) * 2; // 10ms PCM16
    while (this.buf.length >= frameBytes) {
      const frame = this.buf.subarray(0, frameBytes);
      this.buf = this.buf.subarray(frameBytes);
      const samples = new Int16Array(
        frame.buffer,
        frame.byteOffset,
        frame.byteLength / 2,
      );
      const rms = rmsOfInt16(samples);
      for (const ev of this.seg.feed(rms)) {
        if (ev.type === "speech_start") {
          const phrase = MOCK_PHRASES[this.phraseIdx++ % MOCK_PHRASES.length];
          this.words = phrase.split(" ");
          this.spokenWords = 0;
          this.voicedFrames = 0;
        } else if (ev.type === "utterance_end") {
          // The "recognition": whatever the speaker actually said,
          // the mock returns the full canned phrase as the final.
          this.emit({ type: "final", text: this.words.join(" ") });
          this.emit({ type: "utterance_end" });
          this.spokenWords = 0;
        }
      }
      // Simulate streaming recognition: while voiced, one more
      // word of the canned phrase appears every ~160ms.
      if (
        rms >= MOCK_VOICE_RMS &&
        this.words.length > 0 &&
        this.spokenWords < this.words.length
      ) {
        this.voicedFrames++;
        if (this.voicedFrames % 16 === 0) {
          this.spokenWords++;
          this.emit({
            type: "interim",
            text: this.words.slice(0, this.spokenWords).join(" "),
          });
        }
      }
    }
  }

  stop() {
    if (!this.done && this.seg.sawSpeech && this.spokenWords < this.words.length) {
      this.emit({ type: "final", text: this.words.join(" ") });
      this.emit({ type: "utterance_end" });
    }
    this.done = true;
  }

  close() {
    this.done = true;
  }
}

// ---------------------------------------------------------------------
// Deepgram provider
// ---------------------------------------------------------------------

class DeepgramProvider implements SttProvider {
  private ws: WebSocket | null = null;
  private queue: Buffer[] = [];
  private closed = false;
  private everOpened = false;
  private fellBack = false;
  private errEmitted = false;

  constructor(
    private key: string,
    private model: string,
    language: string | undefined,
    private emit: Emit,
  ) {
    // BCP47 ("en-US", "nb-NO") → primary subtag ("en", "nb").
    this.language = language?.split("-")[0] || undefined;
  }

  private language: string | undefined;

  private connect() {
    if (this.ws || this.closed) return;
    const params = new URLSearchParams({
      model: this.model,
      encoding: "linear16",
      sample_rate: "24000",
      channels: "1",
      smart_format: "true",
      interim_results: "true",
      endpointing: "300",
      utterance_end_ms: "1000", // Deepgram minimum step size
    });
    if (this.language) params.set("language", this.language);
    const ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen?${params}`,
      { headers: { Authorization: `Token ${this.key}` } },
    );
    this.ws = ws;
    ws.on("open", () => {
      this.everOpened = true;
      for (const b of this.queue) ws.send(b);
      this.queue = [];
    });
    ws.on("message", (data: Buffer) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const m = msg as {
        type?: string;
        is_final?: boolean;
        speech_final?: boolean;
        channel?: { alternatives?: Array<{ transcript?: string }> };
      };
      const text = m.channel?.alternatives?.[0]?.transcript ?? "";
      if (m.type === "Results") {
        if (text) {
          if (m.is_final) this.emit({ type: "final", text });
          else this.emit({ type: "interim", text });
        }
        // speech_final: Deepgram's endpointing decided the speaker
        // paused. UtteranceEnd is the authoritative duplicate —
        // the client treats both idempotently per utterance.
        if (m.speech_final) this.emit({ type: "utterance_end" });
      } else if (m.type === "UtteranceEnd") {
        this.emit({ type: "utterance_end" });
      }
    });
    ws.on("error", (err: Error) => {
      if (this.ws !== ws) return;
      if (!this.everOpened && !this.errEmitted) {
        // Handshake-level failure. nova-3 only accepts a specific
        // language list (e.g. it rejects "nb"); if the client's
        // locale isn't one of them, silently fall back to multi —
        // Deepgram's auto-detection — instead of failing the mode.
        if (
          this.language &&
          this.language !== "multi" &&
          !this.fellBack
        ) {
          this.fellBack = true;
          this.language = "multi";
          this.ws = null;
          this.connect();
          return;
        }
        this.errEmitted = true;
        this.emit({
          type: "error",
          message: /401/.test(err.message)
            ? "Deepgram rejected the API key (VOICE_STT_API_KEY)."
            : `Deepgram connection failed: ${err.message}`,
        });
      }
    });
    ws.on("close", (code) => {
      if (this.ws !== ws) return; // replaced by the language fallback
      this.ws = null;
      if (this.closed) return;
      if (!this.everOpened) return; // handshake error already handled
      this.emit({
        type: "error",
        message: `Deepgram connection closed (code ${code}).`,
      });
    });
  }

  control(msg: unknown) {
    const m = msg as { type?: string; language?: string };
    if (m?.type === "start") {
      this.language = m.language || this.language;
      this.connect();
    }
  }

  audio(chunk: Buffer) {
    if (this.closed) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(chunk);
    else this.queue.push(chunk);
  }

  stop() {
    // Deepgram's KeepAlive/Close: sending Close makes them return
    // a CloseSummary. Simpler: just close; finals were streamed.
    this.close();
  }

  close() {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}

// ---------------------------------------------------------------------
// Provider factory + endpoint
// ---------------------------------------------------------------------

function createProvider(emit: Emit, language: string | undefined): SttProvider {
  const kind = (process.env.VOICE_STT_PROVIDER ?? "mock").toLowerCase();
  if (kind === "deepgram") {
    const key = process.env.VOICE_STT_API_KEY ?? "";
    if (!key) {
      emit({
        type: "error",
        message:
          "VOICE_STT_PROVIDER=deepgram but VOICE_STT_API_KEY is not set.",
      });
      return new MockProvider(emit);
    }
    return new DeepgramProvider(
      key,
      process.env.VOICE_STT_MODEL ?? "nova-2",
      language,
      emit,
    );
  }
  return new MockProvider(emit);
}

/**
 * Minimal structural type for "an HTTP server that can emit
 * upgrade events" — matches node:http's Server without binding
 * to one type space (Vite's is subtly different).
 */
interface UpgradeServer {
  on(
    event: "upgrade",
    listener: (
      req: import("node:http").IncomingMessage,
      socket: import("node:stream").Duplex,
      head: Buffer,
    ) => void,
  ): unknown;
}

/**
 * Attach the /api/voice WebSocket endpoint to an HTTP server (the
 * Vite dev server). Only upgrades for this exact path are handled;
 * Vite's HMR socket is untouched.
 *
 * `log` is a best-effort diagnostic sink — every connection,
 * provider session and audio byte count is reported so a
 * "mic on but nothing happens" report can be pinpointed from the
 * server log instead of guesswork.
 */
export function attachVoiceServer(
  httpServer: UpgradeServer,
  log: (msg: string) => void = () => {},
) {
  const wss = new WebSocketServer({ noServer: true });
  let connSeq = 0;
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/voice") return;
    wss.handleUpgrade(req, socket, head, (client) => {
      const id = ++connSeq;
      let provider: SttProvider | null = null;
      let bytesIn = 0;
      let sawFirstAudio = false;
      let eventsOut = 0;
      const emit = (ev: ToClient) => {
        if (client.readyState === WebSocket.OPEN) {
          eventsOut++;
          if (ev.type === "error") {
            log(`voice #${id}: error → ${ev.message}`);
          }
          client.send(JSON.stringify(ev));
        }
      };
      log(`voice #${id}: connected`);

      client.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          if (!sawFirstAudio) {
            sawFirstAudio = true;
            log(`voice #${id}: first audio (${data.length}B)`);
          }
          bytesIn += data.length;
          provider?.audio(data);
          return;
        }
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        const m = msg as { type?: string; language?: string };
        if (!m?.type) return;
        if (m.type === "start") {
          provider?.close();
          provider = createProvider(emit, m.language);
          provider.control(m);
          log(`voice #${id}: start (lang=${m.language ?? "-"})`);
        } else if (m.type === "stop") {
          provider?.stop();
        }
      });

      client.on("close", () => {
        log(
          `voice #${id}: closed (audio=${bytesIn}B, events=${eventsOut})`,
        );
        provider?.close();
        provider = null;
      });
      client.on("error", () => {
        provider?.close();
        provider = null;
      });
    });
  });
  return () => wss.close();
}