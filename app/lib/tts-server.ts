import { WebSocket, WebSocketServer } from "ws";

/**
 * Neural text-to-speech — server side.
 *
 * The browser POSTs nothing; narration goes over a WebSocket at
 * /api/tts. The client sends:
 *
 *   { "type": "speak", "text": "…" }   — synthesize + stream audio
 *   { "type": "cancel" }               — drop the current synthesis
 *
 * and receives binary frames (PCM16 little-endian, 24kHz, mono —
 * same shape the STT side sends upstream) plus a JSON control
 * frame { "type": "end" } when a synthesis completes. The API key
 * lives in the server env; the browser never sees it.
 *
 * Provider (VOICE_TTS_PROVIDER): "deepgram" — Aura-2 via their
 * /v1/speak WebSocket (Speak + Flush, audio relays back; we close
 * the upstream on Flushed since we synthesize one sentence per
 * request — narration arrives as sentence-sized chunks from the
 * chat view). Default voice: VOICE_TTS_MODEL / aura-2-thalia-en.
 * Falls back to "browser" (the client's speechSynthesis) when no
 * key is configured.
 *
 * One upstream connection per speak request — Aura connections
 * pin voice and settings, and per-connection flush budgets make
 * anything stateful a liability for a sentence-at-a-time proxy.
 */

export interface TtsConfig {
  provider: "deepgram" | "browser";
  model: string;
  voices: Array<{ id: string; label: string }>;
}

/**
 * Aura-2 English voices (see the Deepgram docs for the current
 * list). Served to the client for the voice picker; also the
 * validation set for per-request voice overrides.
 */
export const AURA2_EN_VOICES: Array<{ id: string; label: string }> = [
  { id: "aura-2-asteria-en", label: "Asteria" },
  { id: "aura-2-thalia-en", label: "Thalia" },
  { id: "aura-2-athena-en", label: "Athena" },
  { id: "aura-2-hera-en", label: "Hera" },
  { id: "aura-2-orion-en", label: "Orion" },
  { id: "aura-2-zeus-en", label: "Zeus" },
  { id: "aura-2-andromeda-en", label: "Andromeda" },
  { id: "aura-2-apollo-en", label: "Apollo" },
  { id: "aura-2-arcas-en", label: "Arcas" },
  { id: "aura-2-aries-en", label: "Aries" },
  { id: "aura-2-atlas-en", label: "Atlas" },
  { id: "aura-2-aurora-en", label: "Aurora" },
  { id: "aura-2-callista-en", label: "Callista" },
  { id: "aura-2-cora-en", label: "Cora" },
  { id: "aura-2-cordelia-en", label: "Cordelia" },
  { id: "aura-2-delia-en", label: "Delia" },
  { id: "aura-2-draco-en", label: "Draco" },
  { id: "aura-2-electra-en", label: "Electra" },
  { id: "aura-2-harmonia-en", label: "Harmonia" },
  { id: "aura-2-helena-en", label: "Helena" },
  { id: "aura-2-hermes-en", label: "Hermes" },
  { id: "aura-2-hyperion-en", label: "Hyperion" },
  { id: "aura-2-iris-en", label: "Iris" },
  { id: "aura-2-janus-en", label: "Janus" },
  { id: "aura-2-juno-en", label: "Juno" },
  { id: "aura-2-luna-en", label: "Luna" },
  { id: "aura-2-mars-en", label: "Mars" },
  { id: "aura-2-minerva-en", label: "Minerva" },
  { id: "aura-2-neptune-en", label: "Neptune" },
  { id: "aura-2-ophelia-en", label: "Ophelia" },
  { id: "aura-2-orpheus-en", label: "Orpheus" },
  { id: "aura-2-pandora-en", label: "Pandora" },
  { id: "aura-2-phoebe-en", label: "Phoebe" },
  { id: "aura-2-saturn-en", label: "Saturn" },
  { id: "aura-2-selene-en", label: "Selene" },
  { id: "aura-2-theia-en", label: "Theia" },
  { id: "aura-2-vesta-en", label: "Vesta" },
];

/** Only known Aura-2 English voices may be requested per-speak —
 *  anything else falls back to the configured default. */
export function validVoice(voice: string | undefined, fallback: string): string {
  if (voice && AURA2_EN_VOICES.some((v) => v.id === voice)) return voice;
  return fallback;
}

export function ttsKey(): string | undefined {
  return (
    process.env.VOICE_TTS_API_KEY ?? process.env.VOICE_STT_API_KEY ?? undefined
  );
}

export function ttsConfig(): TtsConfig {
  const kind = (process.env.VOICE_TTS_PROVIDER ?? "auto").toLowerCase();
  const key = ttsKey();
  if (kind === "browser" || (kind === "auto" && !key)) {
    return { provider: "browser", model: "", voices: [] };
  }
  return {
    provider: "deepgram",
    model: process.env.VOICE_TTS_MODEL ?? "aura-2-thalia-en",
    voices: AURA2_EN_VOICES,
  };
}

interface TtsUpgradeServer {
  on(
    event: "upgrade",
    listener: (
      req: import("node:http").IncomingMessage,
      socket: import("node:stream").Duplex,
      head: Buffer,
    ) => void,
  ): unknown;
}

/** Attach the /api/tts WebSocket endpoint (see voice-server.ts for
 *  the twin of this pattern on the STT side). */
export function attachTtsServer(
  httpServer: TtsUpgradeServer,
  log: (msg: string) => void = () => {},
) {
  const wss = new WebSocketServer({ noServer: true });
  let connSeq = 0;
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/tts") return;
    const cfg = ttsConfig();
    if (cfg.provider !== "deepgram") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const id = ++connSeq;
      let upstream: WebSocket | null = null;
      let bytesOut = 0;
      let speaks = 0;
      log(`tts #${id}: connected (${cfg.model})`);
      const dropUpstream = () => {
        if (upstream) {
          const u = upstream;
          upstream = null;
          u.removeAllListeners();
          try {
            u.close();
          } catch {}
        }
      };

      client.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        const m = msg as { type?: string; text?: string; voice?: string };
        if (m?.type === "speak" && typeof m.text === "string" && m.text) {
          const voice = validVoice(m.voice, cfg.model);
          speaks += 1;
          dropUpstream(); // one synthesis at a time (client queues)
          const u = new WebSocket(
            `wss://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice)}&encoding=linear16&sample_rate=24000`,
            { headers: { Authorization: `Token ${ttsKey()}` } },
          );
          upstream = u;
          let flushed = false;
          u.on("open", () => {
            u.send(JSON.stringify({ type: "Speak", text: m.text }));
            u.send(JSON.stringify({ type: "Flush" }));
          });
          u.on("message", (audio: Buffer, isAudioBinary: boolean) => {
            if (upstream !== u) return;
            if (isAudioBinary && client.readyState === WebSocket.OPEN) {
              bytesOut += audio.length;
              client.send(audio);
            } else if (!isAudioBinary) {
              // Metadata / Flushed / Warning — Flushed means the
              // synthesis is complete; close upstream and signal.
              try {
                const ctl = JSON.parse(audio.toString()) as { type?: string };
                if (ctl.type === "Flushed") flushed = true;
              } catch {}
              if (flushed) {
                dropUpstream();
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({ type: "end" }));
                }
              }
            }
          });
          u.on("error", () => {
            if (upstream !== u) return;
            dropUpstream();
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: "error",
                  message: "TTS synthesis failed.",
                }),
              );
              client.send(JSON.stringify({ type: "end" }));
            }
          });
          u.on("close", () => {
            if (upstream !== u) return;
            dropUpstream();
            // upstream died without Flushed — still unblock the client
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: "end" }));
            }
          });
        } else if (m?.type === "cancel") {
          dropUpstream();
        }
      });

      client.on("close", () => {
        log(`tts #${id}: closed (${speaks} speaks, ${bytesOut}B audio)`);
        dropUpstream();
      });
      client.on("error", () => dropUpstream());
    });
  });
  return () => wss.close();
}