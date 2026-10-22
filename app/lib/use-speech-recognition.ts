import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Speech-to-text for the composer, via the Web Speech API
 * (SpeechRecognition / webkitSpeechRecognition). Chrome, Edge and
 * Safari (iOS 14.5+) support it; Firefox does not — the composer
 * hides the mic button when the API is missing.
 *
 * The hook is deliberately transport-only: it never touches the
 * composer's text state. The caller decides what interim/final
 * transcripts mean (the composer shows `base + interim` live and
 * commits finals into `base`).
 *
 * Continuous dictation: browsers end the recognition session
 * after a silence, so `onend` restarts it while the user hasn't
 * tapped the mic off. The restart needs a user gesture on iOS —
 * when it's denied, dictation simply ends (no error spam).
 */

interface SRAlternative {
  transcript: string;
}
interface SRResult {
  0: SRAlternative;
  isFinal: boolean;
}
interface SREvent {
  resultIndex: number;
  results: { length: number; [index: number]: SRResult };
}
interface SRErrorEvent {
  error: string;
}
interface SRInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SRCtor = new () => SRInstance;

function getSRCtor(): SRCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SRCtor;
    webkitSpeechRecognition?: SRCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const FRIENDLY_ERRORS: Record<string, string> = {
  "not-allowed":
    "Microphone access was denied — enable it for this site to dictate.",
  "service-not-allowed": "Speech recognition is unavailable on this device.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition network error — check your connection.",
};

export function useSpeechRecognition(opts: {
  /** Interim (not yet final) transcript of the current utterance. */
  onInterim: (text: string) => void;
  /** Finalized transcript. May fire several times per session. */
  onFinal: (text: string) => void;
  /**
   * The session ended for good — the user stopped (or the
   * browser gave up and the restart was denied). Distinct from
   * the onend/onend restarts that keep continuous dictation
   * alive: onStop fires exactly once per start(), after any
   * final result flushed by stop(). Callers commit their
   * transcript here.
   */
  onStop?: () => void;
}) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SRInstance | null>(null);
  // Highest result index already appended as final in the current
  // recognition session. -1 = none yet. Guards against recognizers
  // re-delivering final results (see onresult).
  const finalIdxRef = useRef(-1);
  // Reliable onStop delivery: activeRef tracks whether a
  // recognition session is running; stoppedRef makes fireOnStop
  // idempotent (exactly one onStop per start, no matter how the
  // session ends — stop(), rejected restart, fatal error, or the
  // grace timer below).
  const activeRef = useRef(false);
  const stoppedRef = useRef(true);
  const fireOnStop = useCallback(() => {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    optsRef.current.onStop?.();
  }, []);
  // True between user taps (want to listen) vs. the recognition
  // session actually running (may flap as restarts occur).
  const wantRef = useRef(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Detected post-mount: SSR and the first client render agree
  // (no mic button), the button appears once hydration is done.
  // Computing this during render would make the hydrated tree
  // differ from the SSR markup and trigger a hydration mismatch.
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(getSRCtor() !== null);
  }, []);

  const ensureRec = (): SRInstance | null => {
    if (recRef.current) return recRef.current;
    const Ctor = getSRCtor();
    if (!Ctor) return null;
    const rec = new Ctor();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;

    rec.onstart = () => {
      setListening(true);
      activeRef.current = true;
      // Per-session bookkeeping: result indexes of finals already
      // appended (see onresult). Resets on every (re)start, since
      // a new recognition session starts its results array over.
      finalIdxRef.current = -1;
    };
    rec.onend = () => {
      setListening(false);
      activeRef.current = false;
      if (wantRef.current) {
        try {
          rec.start();
        } catch {
          // Restart without a user gesture (iOS) — end quietly.
          wantRef.current = false;
          fireOnStop();
        }
      } else {
        // Stopped for good (or never started). Any final flushed
        // by stop() has been delivered by now — see the ordering
        // note in onStop's doc comment.
        fireOnStop();
      }
    };
    rec.onresult = (e) => {
      // Some mobile recognizers re-deliver final results they
      // already sent (same segment again, or the whole transcript
      // so far marked final once more). Skip any result at or
      // below the highest final index already processed this
      // session — onFinal would otherwise append duplicates.
      let interim = "";
      let final = "";
      const from = Math.max(e.resultIndex, finalIdxRef.current + 1);
      for (let i = from; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          final += r[0].transcript;
          finalIdxRef.current = i;
        } else {
          interim += r[0].transcript;
        }
      }
      if (final) optsRef.current.onFinal(final);
      if (interim) optsRef.current.onInterim(interim);
    };
    rec.onerror = (e) => {
      // "no-speech" / "aborted" are ordinary session endings, not
      // failures — the onend restart (if wanted) covers them.
      if (e.error === "no-speech" || e.error === "aborted") return;
      setError(FRIENDLY_ERRORS[e.error] ?? `Speech error: ${e.error}`);
      wantRef.current = false;
      // Some fatal error paths never reach onend — don't leave the
      // caller's UI hanging in a listening state.
      fireOnStop();
    };
    recRef.current = rec;
    return rec;
  };

  const start = useCallback(() => {
    const rec = ensureRec();
    if (!rec) return;
    setError(null);
    wantRef.current = true;
    stoppedRef.current = false;
    try {
      rec.start();
    } catch {
      // start() on an already-running session — ignore.
    }
  }, []);

  const stop = useCallback(() => {
    wantRef.current = false;
    setListening(false);
    if (stoppedRef.current) return;
    if (!activeRef.current) {
      // The session already ended on its own (rejected restart,
      // fatal error) — onend will not fire again. Commit now.
      fireOnStop();
      return;
    }
    try {
      recRef.current?.stop();
    } catch {
      fireOnStop();
      return;
    }
    // stop() asks the recognizer to flush its pending final and
    // end the session, which takes a moment on mobile — and some
    // browsers never send onend at all. Arm a grace timer so the
    // caller's UI can't hang waiting for the flush; fireOnStop
    // is idempotent, so a late onend is harmless.
    setTimeout(fireOnStop, 2_000);
  }, [fireOnStop]);

  // Stop on unmount (or route change) so a stray session can't
  // keep the mic indicator lit in another view.
  useEffect(() => {
    return () => {
      wantRef.current = false;
      try {
        recRef.current?.abort();
      } catch {}
    };
  }, []);

  return { supported, listening, error, start, stop };
}