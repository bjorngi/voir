import { useCallback, useEffect, useRef, useState } from "react";
import { appendFinal } from "~/lib/dictation";

/**
 * Voice conversation mode — client side.
 *
 * The loop: tap Voice → mic streams 24kHz PCM16 to /api/voice →
 * normalized transcript events stream back. When the recognizer
 * reports an utterance end, the draft gets a short review window
 * (tap to edit, or keep talking to append), then auto-sends.
 * While the agent's turn runs and its reply is narrated, the mic
 * is off (no spoken barge-in — TTS audio through the speaker
 * would bleed back into the mic on a phone; tap to interrupt).
 * When narration finishes, the mic re-opens automatically — the
 * continuous conversation.
 *
 * The transport is ours: unlike the Web Speech API there are no
 * browser recognizer sessions, so there is nothing that can
 * "MIC ENDED" mid-hold. A dropped WebSocket reconnects with
 * backoff; a lost draft never goes silently missing (the review
 * window keeps the last draft visible until it's sent or edited).
 */

export type VoicePhase =
  | "off"
  | "connecting"
  | "listening"
  | "reviewing"
  | "sending"
  | "thinking"
  | "speaking";

export const REVIEW_MS = 2500;

export interface VoiceHandle {
  supported: boolean;
  active: boolean;
  phase: VoicePhase;
  /** Settled transcript (finals) of the utterance in progress. */
  draft: string;
  /** Live preview of the words still settling. */
  interim: string;
  /** When the auto-send countdown started (Date.now()), or null. */
  reviewStartedAt: number | null;
  error: string | null;
  start: () => void;
  stop: () => void;
  /** During the review window: hand the draft to the composer. */
  editNow: () => void;
  /** During thinking/speaking: interrupt — stop narration, listen. */
  bargeIn: () => void;
  /** Nudge a suspended audio context back to running (Android). */
  resume: () => void;
}

export function useVoiceMode(opts: {
  /** Auto-send the transcript as a chat message. */
  onSend: (text: string) => Promise<void>;
  /** Agent turn in flight (drives thinking→speaking→listening). */
  busy: boolean;
  /** Narration currently speaking (checked while phase=thinking). */
  ttsSpeaking: () => boolean;
  /** Cancel narration (barge-in / exit). */
  ttsCancel: () => void;
  /** Voice mode exited to edit: hand the transcript to the composer. */
  onExitToEdit: (text: string) => void;
}): VoiceHandle {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(
      typeof navigator !== "undefined" &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof WebSocket !== "undefined",
    );
  }, []);

  const [phase, setPhase] = useState<VoicePhase>("off");
  const [draft, setDraft] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reviewStartedAt, setReviewStartedAt] = useState<number | null>(null);
  // Ref mirrors so the WS callbacks (which capture closures once
  // per connection) always see current values.
  const interimRef = useRef("");
  const phaseRef = useRef<VoicePhase>("off");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Transport + audio pipeline, all cleaned up in teardown().
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const activeRef = useRef(false);
  const draftRef = useRef("");
  const reviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);

  const sendText = useCallback((text: string) => {
    const t = text.trim();
    draftRef.current = "";
    interimRef.current = "";
    setDraft("");
    setInterim("");
    setReviewStartedAt(null);
    if (!t) return;
    setPhase("sending");
    optsRef.current.onSend(t).catch(() => {
      setError("Failed to send the message.");
    });
  }, []);

  const clearReviewTimer = () => {
    if (reviewTimerRef.current !== null) {
      clearTimeout(reviewTimerRef.current);
      reviewTimerRef.current = null;
    }
  };

  /** Enter the reviewing state: countdown to auto-send. */
  const startReview = useCallback(() => {
    if (!draftRef.current.trim()) return;
    clearReviewTimer();
    setPhase("reviewing");
    const startedAt = Date.now();
    setReviewStartedAt(startedAt);
    reviewTimerRef.current = setTimeout(() => {
      reviewTimerRef.current = null;
      sendText(draftRef.current);
    }, REVIEW_MS);
  }, [sendText]);

  const handleEvent = useCallback(
    (ev: { type: string; text?: string; message?: string }) => {
      // Any new speech cancels a pending auto-send countdown — the
      // user kept talking, so this utterance continues.
      const cancelCountdown = () => {
        if (phaseRef.current === "reviewing") {
          clearReviewTimer();
          setReviewStartedAt(null);
          setPhase("listening");
        }
      };
      switch (ev.type) {
        case "interim":
          cancelCountdown();
          interimRef.current = ev.text ?? "";
          setInterim(ev.text ?? "");
          break;
        case "final": {
          cancelCountdown();
          const t = (ev.text ?? "").trim();
          if (!t) return;
          draftRef.current = appendFinal(draftRef.current, t);
          interimRef.current = "";
          setDraft(draftRef.current);
          setInterim("");
          break;
        }
        case "utterance_end":
          // Only count the pause when nothing is still streaming
          // (a final arriving mid-review already restarted the
          // flow) — the review countdown must not fire under a
          // half-settled draft.
          if (!interimRef.current) startReview();
          break;
        case "error":
          setError(ev.message ?? "Voice error.");
          break;
      }
    },
    [startReview],
  );

  const teardown = useCallback(() => {
    activeRef.current = false;
    clearReviewTimer();
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.onclose = null;
      ws.close();
    }
    if (nodeRef.current) {
      try {
        nodeRef.current.port.onmessage = null;
        nodeRef.current.disconnect();
      } catch {}
      nodeRef.current = null;
    }
    for (const t of streamRef.current?.getTracks() ?? []) t.stop();
    streamRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
  }, []);

  const openSocket = useCallback((): WebSocket | null => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/voice`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onopen = () => {
      attemptsRef.current = 0;
      setError(null);
      ws.send(
        JSON.stringify({ type: "start", language: navigator.language }),
      );
      // "listening" only once the transport is really up — a
      // suspended-context or dead-socket "listening" is a lie.
      setPhase((p) => (p === "connecting" ? "listening" : p));
    };
    ws.onmessage = (e) => {
      try {
        handleEvent(JSON.parse(String(e.data)));
      } catch {}
    };
    ws.onclose = () => {
      if (!activeRef.current) return;
      // Our pipeline, our reconnect — transport drops are not the
      // user's problem. Backoff, cap, and keep the draft. Surface
      // it so "nothing happens" is never the symptom.
      setError("Voice connection lost — reconnecting…");
      attemptsRef.current += 1;
      if (attemptsRef.current > 6) {
        setError("Voice connection lost.");
        return;
      }
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!activeRef.current) return;
        openSocket();
      }, Math.min(1000 * 2 ** Math.min(attemptsRef.current, 3), 4000));
    };
    return ws;
  }, [handleEvent]);

  const start = useCallback(() => {
    if (activeRef.current) return;
    activeRef.current = true;
    draftRef.current = "";
    interimRef.current = "";
    attemptsRef.current = 0;
    setError(null);
    setDraft("");
    setInterim("");
    setReviewStartedAt(null);
    setPhase("connecting");

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        streamRef.current = stream;
        const ctx = new AudioContext();
        ctxRef.current = ctx;
        // Mobile Chrome creates AudioContexts suspended — the mic
        // track is live (OS indicator on!) but the graph doesn't
        // run, so no frames ever leave the device and the symptom
        // is exactly "mic on, nothing happens". Resume it, and keep
        // a `resume()` escape hatch for taps.
        if (ctx.state === "suspended") {
          await ctx.resume().catch(() => {});
        }
        await ctx.audioWorklet.addModule("/pcm-worklet.js");
        if (!activeRef.current) return teardown();
        const node = new AudioWorkletNode(ctx, "pcm-downsampler");
        nodeRef.current = node;
        // AudioWorkletNodes only process when they reach the
        // destination — sink through a zero-gain node.
        const sink = ctx.createGain();
        sink.gain.value = 0;
        node.connect(sink).connect(ctx.destination);
        const src = ctx.createMediaStreamSource(stream);
        src.connect(node);
        node.port.onmessage = (e) => {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(e.data as ArrayBuffer);
          }
        };
        openSocket();
        // No setPhase("listening") here: the socket's onopen flips
        // the phase once the transport is genuinely up.
      } catch (err) {
        setError(
          (err as Error).name === "NotAllowedError"
            ? "Microphone access was denied — enable it for this site."
            : `Voice mode failed to start: ${(err as Error).message}`,
        );
        teardown();
        setPhase("off");
      }
    })();
  }, [openSocket, teardown]);

  const stop = useCallback(() => {
    teardown();
    optsRef.current.ttsCancel();
    interimRef.current = "";
    setPhase("off");
    setDraft("");
    setInterim("");
    setReviewStartedAt(null);
  }, [teardown]);

  const editNow = useCallback(() => {
    const text = draftRef.current.trim();
    teardown();
    optsRef.current.ttsCancel();
    interimRef.current = "";
    setPhase("off");
    setDraft("");
    setInterim("");
    setReviewStartedAt(null);
    if (text) optsRef.current.onExitToEdit(text);
  }, [teardown]);

  const bargeIn = useCallback(() => {
    optsRef.current.ttsCancel();
    clearReviewTimer();
    // Only meaningful from thinking/speaking — otherwise a no-op.
    setPhase((p) => (p === "thinking" || p === "speaking" ? "listening" : p));
  }, []);

  /** Best-effort resume of a suspended audio context (Android can
   *  suspend it mid-session — screen lock, backgrounding; taps
   *  count as the gesture that lets us resume). */
  const resume = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx && ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
  }, []);

  // Turn lifecycle: after a send, follow busy → narration → listen.
  // The POST resolves immediately (the SSE busy flag arrives a beat
  // later), so thinking starts right away and waits for busy to
  // clear below.
  useEffect(() => {
    if (phase === "sending") setPhase("thinking");
  }, [phase]);

  useEffect(() => {
    if (phase !== "thinking" || opts.busy) return;
    // Turn done. Narration is already queued (the reply text landed
    // before the busy:false event) — let the speaking phase poll
    // it out; the mic re-opens when the voice goes quiet.
    const id = setInterval(() => {
      if (optsRef.current.busy) return; // a queued message restarted a turn
      if (optsRef.current.ttsSpeaking()) {
        setPhase((p) => (p === "thinking" ? "speaking" : p));
      } else {
        clearInterval(id);
        setPhase((p) => (p === "thinking" ? "listening" : p));
      }
    }, 200);
    return () => clearInterval(id);
  }, [phase, opts.busy]);

  useEffect(() => {
    if (phase !== "speaking") return;
    const id = setInterval(() => {
      if (optsRef.current.busy) {
        // A queued voice message started a new turn — narration of
        // the previous reply was already cancelled by the send.
        setPhase("thinking");
        clearInterval(id);
        return;
      }
      if (!optsRef.current.ttsSpeaking()) {
        clearInterval(id);
        setPhase("listening");
      }
    }, 200);
    return () => clearInterval(id);
  }, [phase]);

  // Gate the mic by phase: capture only while the user can speak.
  // Re-opening the mic is also the natural moment to nudge a
  // suspended audio context back to running.
  const trackRef = useRef<MediaStreamTrack | null>(null);
  useEffect(() => {
    const track = streamRef.current?.getTracks()[0] ?? trackRef.current;
    if (track) {
      trackRef.current = track;
      track.enabled =
        phase === "listening" || phase === "reviewing" || phase === "connecting";
      if (track.enabled) resume();
    }
  }, [phase, draft, resume]);

  // Unmount: never leave a mic light on.
  useEffect(() => teardown, [teardown]);

  return {
    supported,
    active: phase !== "off",
    phase,
    draft,
    interim,
    reviewStartedAt,
    error,
    start,
    stop,
    editNow,
    bargeIn,
    resume,
  };
}