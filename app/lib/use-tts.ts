import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Spoken replies (text → speech), with two engines behind one API:
 *
 * - **neural** (default when the server has a TTS key, see
 *   GET /api/tts): sentences are sent to the server-proxied
 *   /api/tts WebSocket and synthesized by a streaming neural voice
 *   (Deepgram Aura). Audio comes back as one MP3 blob per sentence
 *   and is played through a single <audio> element, sentence after
 *   sentence, while the *next* sentence synthesizes in the
 *   background.
 * - **browser**: window.speechSynthesis, the always-available
 *   fallback — noticeably synthetic, but zero setup.
 *
 * Why a media element and not Web Audio: narration is the thing you
 * listen to with the screen off. An AudioContext is suspended the
 * moment the page is backgrounded or the screen locks (iOS suspends
 * it outright; Chrome throttles it), and Chrome shows no media
 * notification for Web Audio output at all — so no lock-screen
 * controls, no headphone play/pause, no media-key routing. A media
 * element keeps playing under a locked screen on both platforms and
 * is what puts Voir on the lock screen as the current audio session.
 *
 * The cost is that a sentence is heard after it is synthesized
 * rather than trickling in; narration.ts hands us sentence-sized
 * chunks, Aura synthesizes far faster than realtime, and the next
 * sentence is already in flight while the current one speaks, so
 * the seam between sentences is a decode start, not a round trip.
 *
 * The enabled state persists in localStorage (this is a phone
 * tool; nobody re-enables narration on every visit). speak() is
 * what the chat narration calls; force lets voice-conversation
 * mode narrate regardless of the global toggle.
 *
 * Mobile note: playback needs one user gesture. `preparePlayback()`
 * must be called from one (voice-mode start, toggle tap, panel tap)
 * so the element is unlocked before the first sentence arrives from
 * the network — a play() from a socket message is blocked otherwise.
 */

const STORAGE_KEY = "voir:tts";

// After the neural→browser fallback, how long to stay on browser
// voices before trying neural again (the next speak, or a return
// to the foreground). A maintenance restart of voir (or a flaky
// proxy leg) must not degrade a long-lived PWA tab's voice for
// the whole page session; a still-broken server just re-trips
// the 3-strike and degrades again after another cooldown.
const NEURAL_RETRY_MS = 2 * 60_000;

// Lock-screen identity. The media session is what turns narration
// into a first-class audio session (notification, headphone
// buttons, the lockscreen transport on iOS and Android).
const MEDIA_TITLE = "Voir";
const MEDIA_ARTIST = "narration";

/** 20ms of silence as a WAV object URL — played inside a gesture to
 *  unlock the element, never heard. Created once per page. */
let silentUrl: string | null = null;
function silentWavUrl(): string {
  if (silentUrl) return silentUrl;
  const rate = 8000;
  const samples = Math.round(rate * 0.02);
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples * 2, true);
  silentUrl = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  return silentUrl;
}

export interface Tts {
  /** Any engine available (neural or browser). */
  supported: boolean;
  /** Which engine is live right now. */
  engine: "neural" | "browser" | null;
  /** Neural voices the server accepts (the settings-drawer picker). */
  voices: Array<{ id: string; label: string }>;
  /** Server-default neural voice id, or null. */
  defaultVoice: string | null;
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  /** Speak text. No-op when disabled unless `force` (voice mode
   *  narrates even with the global toggle off). `voice` overrides
   *  the neural voice, `speed` the speaking rate (0.7–1.5). */
  speak: (text: string, opts?: { force?: boolean; voice?: string; speed?: number }) => void;
  /** Drop the utterance queue, including anything mid-speech. */
  cancel: () => void;
  /** Whether audio is queued, in flight, or scheduled to play. */
  speaking: () => boolean;
  /** Unlock the playback element — must be called from a user
   *  gesture on mobile (programmatic play() is blocked until then). */
  preparePlayback: () => void;
}

export function useSpeechSynthesis(): Tts {
  const [enabled, setEnabledState] = useState(false);
  const [browserTts, setBrowserTts] = useState(false);
  const [neuralTts, setNeuralTts] = useState(false);
  const [voices, setVoices] = useState<Array<{ id: string; label: string }>>([]);
  const [defaultVoice, setDefaultVoice] = useState<string | null>(null);

  // Engine discovery post-mount: server config decides neural,
  // window decides the fallback. SSR renders neither.
  useEffect(() => {
    const hasBrowser = "speechSynthesis" in window;
    setBrowserTts(hasBrowser);
    fetch("/api/tts")
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (cfg: {
          provider?: string;
          model?: string;
          voices?: Array<{ id: string; label: string }>;
        } | null) => {
          if (cfg?.provider === "deepgram") {
            setNeuralTts(true);
            setVoices(cfg.voices ?? []);
            setDefaultVoice(cfg.model ?? null);
          }
        },
      )
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
  // Neural engine state. Two queues and one element:
  //
  //   textQueueRef — sentences awaiting synthesis
  //   playQueueRef — synthesized blobs awaiting playback
  //   chunksRef    — MP3 bytes of the sentence currently synthesizing
  //
  // Synthesis runs one sentence ahead of playback, so the element has
  // its next source ready before the current one ends.
  // ------------------------------------------------------------------
  const wsRef = useRef<WebSocket | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const textQueueRef = useRef<Array<{ text: string; voice?: string; speed?: number }>>([]);
  const playQueueRef = useRef<string[]>([]);
  const chunksRef = useRef<BlobPart[]>([]);
  const inFlightRef = useRef(false);
  const playingRef = useRef(false);
  // Consecutive neural-socket failures — after a few, fall back
  // to the browser voices until the retry cooldown passes (see
  // NEURAL_RETRY_MS / retryNeural). Without this a dead endpoint
  // would make the neural engine reconnect forever and never say
  // a word. (The historical trigger — production running
  // react-router-serve with no WebSocket support — is gone:
  // bin/server.ts attaches the /api/tts WS; the remaining triggers
  // are voir restarts and flaky proxy legs.)
  const failCountRef = useRef(0);
  // When the fallback last tripped — the self-heal cooldown clock.
  const degradedAtRef = useRef(0);

  // playNext / pump are mutually recursive with the socket and
  // element callbacks, so both are held in refs and assigned below.
  const playNextRef = useRef<() => void>(() => {});
  const pumpRef = useRef<() => void>(() => {});

  const releaseUrl = (url: string) => {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  };

  /** Lock-screen / media-key identity: present it while audio is
   *  live, clear it when narration ends so a stale widget doesn't
   *  sit on the lock screen. */
  const setLockScreen = useCallback((on: boolean) => {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = on
        ? new MediaMetadata({ title: MEDIA_TITLE, artist: MEDIA_ARTIST, album: MEDIA_TITLE })
        : null;
      navigator.mediaSession.playbackState = on ? "playing" : "none";
    } catch {}
  }, []);

  /** Play the next synthesized sentence, if the element is free. */
  playNextRef.current = () => {
    const el = audioRef.current;
    if (!el || playingRef.current) return;
    const url = playQueueRef.current.shift();
    if (url === undefined) {
      // Drained. Only clear the media session when nothing is left
      // to synthesize either (the pump refills this queue).
      if (!inFlightRef.current && textQueueRef.current.length === 0) {
        setLockScreen(false);
      }
      return;
    }
    playingRef.current = true;
    setLockScreen(true);
    el.src = url;
    const started = el.play();
    if (started && typeof started.catch === "function") {
      started.catch(() => {
        // Blocked (no gesture yet) or an undecodable blob: drop it
        // and keep the chain moving rather than going silent.
        playingRef.current = false;
        releaseUrl(url);
        playNextRef.current();
      });
    }
  };

  const ensureAudio = useCallback((): HTMLAudioElement | null => {
    if (typeof Audio === "undefined") return null;
    const existing = audioRef.current;
    if (existing) return existing;
    const el = new Audio();
    el.preload = "auto";
    el.setAttribute("playsinline", "");
    el.addEventListener("ended", () => {
      const src = el.getAttribute("src");
      playingRef.current = false;
      if (src) {
        el.removeAttribute("src");
        releaseUrl(src);
      }
      playNextRef.current();
    });
    el.addEventListener("error", () => {
      const src = el.getAttribute("src");
      playingRef.current = false;
      if (src) {
        el.removeAttribute("src");
        releaseUrl(src);
      }
      playNextRef.current();
    });
    if ("mediaSession" in navigator) {
      try {
        // Transport controls in the notification / on the lock
        // screen. next/prev are deliberately left unclaimed: the
        // walking surface assigns those to session slots.
        navigator.mediaSession.setActionHandler("play", () => {
          void el.play().catch(() => {});
        });
        navigator.mediaSession.setActionHandler("pause", () => el.pause());
        navigator.mediaSession.setActionHandler("stop", () => {
          el.pause();
          playQueueRef.current.forEach(releaseUrl);
          playQueueRef.current = [];
          textQueueRef.current = [];
          setLockScreen(false);
        });
      } catch {}
    }
    audioRef.current = el;
    return el;
  }, [setLockScreen]);

  const cancel = useCallback(() => {
    textQueueRef.current = [];
    playQueueRef.current.forEach(releaseUrl);
    playQueueRef.current = [];
    chunksRef.current = [];
    inFlightRef.current = false;
    playingRef.current = false;
    const el = audioRef.current;
    if (el) {
      const src = el.getAttribute("src");
      try {
        el.pause();
      } catch {}
      el.removeAttribute("src");
      if (src) releaseUrl(src);
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {}
    }
    setLockScreen(false);
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, [setLockScreen]);

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

  /** The socket said "end": this sentence's audio is complete. Queue
   *  the blob, kick playback, and immediately start the next
   *  sentence — synthesis stays one sentence ahead of the voice. */
  const finishSentence = useCallback(() => {
    const parts = chunksRef.current;
    chunksRef.current = [];
    inFlightRef.current = false;
    if (parts.length > 0) {
      const blob = new Blob(parts, { type: "audio/mpeg" });
      // A handful of bytes is a truncated frame or an empty
      // synthesis — playing it would be a click, not a word.
      if (blob.size > 512) {
        playQueueRef.current.push(URL.createObjectURL(blob));
        playNextRef.current();
      }
    }
    pumpRef.current();
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
        chunksRef.current.push(e.data as ArrayBuffer);
        return;
      }
      let msg: { type?: string };
      try {
        msg = JSON.parse(e.data) as { type?: string };
      } catch {
        return;
      }
      if (msg.type === "end") {
        finishSentence();
      } else if (msg.type === "error") {
        chunksRef.current = [];
        inFlightRef.current = false;
        pumpRef.current();
      }
    };
    ws.onopen = () => {
      failCountRef.current = 0;
    };
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
      chunksRef.current = [];
      inFlightRef.current = false;
      // Fall back to browser voices after repeated connection
      // failures — drain the queue through speechSynthesis so the
      // narration still happens, just less beautifully.
      failCountRef.current += 1;
      if (failCountRef.current >= 3) {
        setNeuralTts(false);
        neuralRef.current = false;
        degradedAtRef.current = Date.now();
        const pending = textQueueRef.current;
        textQueueRef.current = [];
        if ("speechSynthesis" in window) {
          for (const { text } of pending) {
            const u = new SpeechSynthesisUtterance(text);
            u.lang = navigator.language;
            window.speechSynthesis.speak(u);
          }
        }
        return;
      }
      pumpRef.current();
    };
    return ws;
  }, [finishSentence]);

  const speakNeural = useCallback((text: string, voice?: string, speed?: number) => {
    textQueueRef.current.push({ text, voice, speed });
    pumpRef.current();
  }, []);

  // One sentence at a time: send the next when the previous one has
  // been synthesized, not when it has been spoken (see finishSentence).
  pumpRef.current = () => {
    if (inFlightRef.current || textQueueRef.current.length === 0) return;
    const next = textQueueRef.current.shift();
    if (next === undefined) return;
    inFlightRef.current = true;
    chunksRef.current = [];
    const ws = ensureSocket();
    if (!ws) {
      inFlightRef.current = false;
      return;
    }
    const send = () =>
      ws.send(
        JSON.stringify({
          type: "speak",
          text: next.text,
          // Lock-screen playback needs a container the element can
          // decode; the server passes this through to the provider.
          encoding: "mp3",
          ...(next.voice ? { voice: next.voice } : {}),
          ...(next.speed ? { speed: next.speed } : {}),
        }),
      );
    if (ws.readyState === WebSocket.OPEN) send();
    else ws.onopen = () => send();
  };

  const preparePlayback = useCallback(() => {
    const el = ensureAudio();
    if (el && !playingRef.current && playQueueRef.current.length === 0) {
      // Unlock: both mobile platforms refuse a programmatic play()
      // until the element has played once inside a gesture. Twenty
      // milliseconds of silence is inaudible and enough.
      try {
        el.src = silentWavUrl();
        const started = el.play();
        if (started && typeof started.then === "function") {
          started.then(() => el.pause()).catch(() => {});
        }
      } catch {}
    }
    if ("speechSynthesis" in window) {
      // Warm the browser voices (iOS populates them lazily).
      void window.speechSynthesis.getVoices();
    }
  }, [ensureAudio]);

  /** Self-heal: flip back to the neural engine once the cooldown
   *  has passed. Called from speak() and on foreground return —
   *  the engine only got here by failing three connections in a
   *  row, and "stays degraded until the next reload" was a
   *  maintenance-restart footgun. A still-broken server re-trips
   *  the 3-strike (a fresh window) and degrades again. */
  const retryNeural = useCallback(() => {
    if (neuralRef.current) return;
    if (Date.now() - degradedAtRef.current < NEURAL_RETRY_MS) return;
    degradedAtRef.current = 0;
    failCountRef.current = 0;
    setNeuralTts(true);
    neuralRef.current = true;
  }, []);

  // Foreground return is the natural retry point on a phone: the
  // tab backgrounded through the outage and came back after it.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") retryNeural();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [retryNeural]);

  const speak = useCallback(
    (text: string, sopts?: { force?: boolean; voice?: string; speed?: number }) => {
      if (!text) return;
      if (!enabledRef.current && !sopts?.force) return;
      if (!neuralRef.current) retryNeural();
      if (neuralRef.current) {
        preparePlayback();
        speakNeural(text, sopts?.voice, sopts?.speed);
        return;
      }
      if ("speechSynthesis" in window) {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = navigator.language;
        if (sopts?.speed && sopts.speed >= 0.5 && sopts.speed <= 2) {
          u.rate = sopts.speed; // browser fallback has 0.1–10, kept sane
        }
        window.speechSynthesis.speak(u);
      }
    },
    [preparePlayback, speakNeural, retryNeural],
  );

  const speaking = useCallback(() => {
    if (neuralRef.current) {
      const el = audioRef.current;
      return (
        textQueueRef.current.length > 0 ||
        playQueueRef.current.length > 0 ||
        inFlightRef.current ||
        (el !== null && !el.paused && !el.ended)
      );
    }
    if ("speechSynthesis" in window) {
      return window.speechSynthesis.speaking || window.speechSynthesis.pending;
    }
    return false;
  }, []);

  // Leaving the chat must not leave a reply talking over the
  // folder list.
  useEffect(() => cancel, [cancel]);

  return {
    supported: neuralTts || browserTts,
    engine: neuralTts ? "neural" : browserTts ? "browser" : null,
    voices,
    defaultVoice,
    enabled,
    setEnabled,
    speak,
    cancel,
    speaking,
    preparePlayback,
  };
}
