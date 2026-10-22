import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Spoken replies (text → speech), with two engines behind one API:
 *
 * - **neural** (default when the server has a TTS key, see
 *   GET /api/tts): sentences are sent to the server-proxied
 *   /api/tts WebSocket and synthesized by a streaming neural voice
 *   (Deepgram Aura). Binary PCM16@24kHz chunks come back and are
 *   scheduled gaplessly on a Web Audio graph — narration tracks
 *   the text, sentence by sentence, as it streams in.
 * - **browser**: window.speechSynthesis, the always-available
 *   fallback — noticeably synthetic, but zero setup.
 *
 * The enabled state persists in localStorage (this is a phone
 * tool; nobody re-enables narration on every visit). speak() is
 * what the chat narration calls; force lets voice-conversation
 * mode narrate regardless of the global toggle.
 *
 * Mobile note: playback needs an AudioContext, which starts
 * suspended without a user gesture — `preparePlayback()` must be
 * called from one (voice-mode start, toggle tap, panel tap).
 */

const STORAGE_KEY = "voir:tts";

// Neural playback: incoming PCM16 chunks are tiny (Deepgram
// streams continuously); batch them to ~200ms before scheduling
// so we don't spin up a source node every frame.
const NEURAL_BATCH_SAMPLES = 4800;

export interface Tts {
  /** Any engine available (neural or browser). */
  supported: boolean;
  /** Which engine is live right now. */
  engine: "neural" | "browser" | null;
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  /** Speak text. No-op when disabled unless `force` (voice mode
   *  narrates even with the global toggle off). */
  speak: (text: string, opts?: { force?: boolean }) => void;
  /** Drop the utterance queue, including anything mid-speech. */
  cancel: () => void;
  /** Whether audio is queued, in flight, or scheduled to play. */
  speaking: () => boolean;
  /** Create/resume the playback AudioContext — must be called from\n   *  a user gesture on mobile (AudioContexts start suspended). */
  preparePlayback: () => void;
}

export function useSpeechSynthesis(): Tts {
  const [enabled, setEnabledState] = useState(false);
  const [browserTts, setBrowserTts] = useState(false);
  const [neuralTts, setNeuralTts] = useState(false);

  // Engine discovery post-mount: server config decides neural,
  // window decides the fallback. SSR renders neither.
  useEffect(() => {
    const hasBrowser = "speechSynthesis" in window;
    setBrowserTts(hasBrowser);
    fetch("/api/tts")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg: { provider?: string } | null) => {
        if (cfg?.provider === "deepgram") setNeuralTts(true);
      })
      .catch(() => {});
  }, []);

  // Post-mount persistence read (SSR/hydration agreement).
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "1") {
        setEnabledState(true);
      }
    } catch {
      // Private mode et al. — persistence is best-effort.
    }
  }, []);

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const neuralRef = useRef(false);
  neuralRef.current = neuralTts;

  // ------------------------------------------------------------------
  // Neural engine state. Sentences are serialized: one speak
  // request in flight, the rest in queueRef; audio chunks
  // accumulate in sampleRef and flush as scheduled buffers.
  // ------------------------------------------------------------------
  const wsRef = useRef<WebSocket | null>(null);
  const actxRef = useRef<AudioContext | null>(null);
  const queueRef = useRef<string[]>([]);
  const inFlightRef = useRef(false);
  const sourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const nextStartRef = useRef(0);
  const sampleRef = useRef<number[]>([]);

  const cancel = useCallback(() => {
    if (neuralRef.current) {
      queueRef.current = [];
      inFlightRef.current = false;
      sampleRef.current = [];
      nextStartRef.current = 0;
      for (const s of sourcesRef.current) {
        try {
          s.stop();
        } catch {}
      }
      sourcesRef.current.clear();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && ws.readyState <= WebSocket.OPEN) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {}
      }
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  const setEnabled = useCallback(
    (v: boolean) => {
      setEnabledState(v);
      try {
        window.localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
      } catch {}
      if (!v) cancel();
    },
    [cancel],
  );

  /** Schedule accumulated samples as one gapless AudioBuffer. */
  const flushSamples = useCallback(() => {
    const actx = actxRef.current;
    const samples = sampleRef.current;
    if (!actx || samples.length === 0) return;
    const buffer = actx.createBuffer(1, samples.length, 24000);
    buffer.copyToChannel(new Float32Array(samples), 0);
    sampleRef.current = [];
    const src = actx.createBufferSource();
    src.buffer = buffer;
    src.connect(actx.destination);
    const t = Math.max(actx.currentTime + 0.02, nextStartRef.current);
    src.start(t);
    nextStartRef.current = t + buffer.duration;
    sourcesRef.current.add(src);
    src.onended = () => sourcesRef.current.delete(src);
  }, []);

  const ensureSocket = useCallback((): WebSocket | null => {
    const existing = wsRef.current;
    if (existing && existing.readyState <= WebSocket.OPEN) return existing;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/tts`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        // PCM16 LE mono 24kHz → Float32 samples.
        const pcm = new Int16Array(e.data as ArrayBuffer);
        const out = sampleRef.current;
        for (let i = 0; i < pcm.length; i++) out.push(pcm[i] / 32768);
        if (out.length >= NEURAL_BATCH_SAMPLES) flushSamples();
        return;
      }
      try {
        const msg = JSON.parse(e.data) as { type?: string };
        if (msg.type === "end" || msg.type === "error") {
          flushSamples();
          inFlightRef.current = false;
          pumpRef.current();
        }
      } catch {}
    };
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
      flushSamples();
      inFlightRef.current = false;
      pumpRef.current();
    };
    return ws;
  }, [flushSamples]);

  const pumpRef = useRef<() => void>(() => {});

  const speakNeural = useCallback(
    (text: string) => {
      queueRef.current.push(text);
      pumpRef.current();
    },
    [],
  );

  // One sentence at a time: when a synthesis ends ("end"/close),
  // send the next. The in-flight sentence is shifted from the
  // queue here, not at enqueue time.
  pumpRef.current = () => {
    if (inFlightRef.current || queueRef.current.length === 0) return;
    const next = queueRef.current.shift();
    if (next === undefined) return;
    inFlightRef.current = true;
    const ws = ensureSocket();
    if (!ws) {
      inFlightRef.current = false;
      return;
    }
    const send = () => ws.send(JSON.stringify({ type: "speak", text: next }));
    if (ws.readyState === WebSocket.OPEN) send();
    else ws.onopen = () => send();
  };

  const preparePlayback = useCallback(() => {
    if (!actxRef.current) {
      try {
        actxRef.current = new AudioContext();
      } catch {}
    }
    const ctx = actxRef.current;
    if (ctx && ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    if ("speechSynthesis" in window) {
      // Warm the browser voices (iOS populates them lazily).
      void window.speechSynthesis.getVoices();
    }
  }, []);

  const speak = useCallback(
    (text: string, sopts?: { force?: boolean }) => {
      if (!text) return;
      if (!enabledRef.current && !sopts?.force) return;
      if (neuralRef.current) {
        preparePlayback();
        speakNeural(text);
        return;
      }
      if ("speechSynthesis" in window) {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = navigator.language;
        window.speechSynthesis.speak(u);
      }
    },
    [preparePlayback, speakNeural],
  );

  const speaking = useCallback(() => {
    if (neuralRef.current) {
      const actx = actxRef.current;
      return (
        queueRef.current.length > 0 ||
        inFlightRef.current ||
        (actx !== null && nextStartRef.current > actx.currentTime) ||
        sampleRef.current.length > 0
      );
    }
    if ("speechSynthesis" in window) {
      return (
        window.speechSynthesis.speaking || window.speechSynthesis.pending
      );
    }
    return false;
  }, []);

  // Leaving the chat must not leave a reply talking over the
  // folder list.
  useEffect(() => cancel, [cancel]);

  return {
    supported: neuralTts || browserTts,
    engine: neuralTts ? "neural" : browserTts ? "browser" : null,
    enabled,
    setEnabled,
    speak,
    cancel,
    speaking,
    preparePlayback,
  };
}