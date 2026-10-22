/**
 * Voice conversation mode panel — replaces the composer while
 * active. A big mic orb shows the loop's phase (listening /
 * reviewing / thinking / speaking), the live transcript renders
 * underneath, and the orb's tap is contextual: during the review
 * window it hands the draft to the composer for editing (the
 * "fix STT mistakes" affordance), during thinking/speaking it
 * barges in and re-opens the mic.
 *
 * Esc exits voice mode.
 */
import { useEffect, useState } from "react";
import type { VoiceHandle } from "~/lib/use-voice";
import { REVIEW_MS } from "~/lib/use-voice";

const STATUS: Record<VoiceHandle["phase"], string> = {
  off: "",
  connecting: "Connecting mic…",
  listening: "Listening…",
  reviewing: "Sending…",
  sending: "Sending…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

export function VoicePanel({ voice }: { voice: VoiceHandle }) {
  // Countdown for the review window ("Sending in 2s — tap to
  // edit") — driven by reviewStartedAt, re-rendered each 100ms.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (voice.phase !== "reviewing") return;
    const id = setInterval(() => forceTick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [voice.phase, voice.reviewStartedAt]);

  // Esc exits voice mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") voice.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [voice]);

  const remaining =
    voice.phase === "reviewing" && voice.reviewStartedAt
      ? Math.max(
          0,
          Math.ceil((REVIEW_MS - (Date.now() - voice.reviewStartedAt)) / 1000),
        )
      : null;

  const orbLive = voice.phase === "listening" || voice.phase === "reviewing";
  const hint =
    voice.phase === "listening"
      ? "Pause when you're done — it sends itself. Tap Done to exit."
      : voice.phase === "reviewing"
        ? `Sending in ${remaining}s — tap the orb to edit, or keep talking`
        : voice.phase === "thinking" || voice.phase === "speaking"
          ? "Tap the orb to interrupt and keep talking"
          : "";

  const transcript = voice.draft || voice.interim;

  return (
    <div className="relative shrink-0 border-t border-neutral-800 bg-neutral-950 px-3 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-3">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-3">
        <div className="flex w-full items-center justify-between">
          <span
            className={
              "font-mono text-[11px] uppercase tracking-wider " +
              (orbLive ? "text-amber-300" : "text-neutral-500")
            }
          >
            {STATUS[voice.phase]}
            {remaining !== null && remaining > 0 ? ` in ${remaining}s` : ""}
          </span>
          <button
            type="button"
            onClick={voice.stop}
            className="border border-neutral-800 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-neutral-400 active:bg-neutral-800"
          >
            Done
          </button>
        </div>

        {/* Mic orb — the contextual tap target. */}
        <button
          type="button"
          aria-label={
            voice.phase === "reviewing"
              ? "Edit transcript before sending"
              : voice.phase === "thinking" || voice.phase === "speaking"
                ? "Interrupt and speak"
                : "Voice mode"
          }
          onClick={() => {
            // Every tap also nudges the audio context — Android
            // can suspend it mid-session (screen lock, tab switch)
            // and only a gesture lets us resume.
            voice.resume();
            if (voice.phase === "reviewing") voice.editNow();
            else if (voice.phase === "thinking" || voice.phase === "speaking")
              voice.bargeIn();
            else if (voice.phase !== "off" && voice.phase !== "connecting")
              voice.stop();
          }}
          className={
            "flex h-16 w-16 select-none items-center justify-center rounded-full border transition-colors [touch-action:manipulation] " +
            (orbLive
              ? "border-amber-400/60 text-amber-300"
              : "border-neutral-700 text-neutral-500")
          }
        >
          <span
            aria-hidden="true"
            className={
              "inline-block h-3 w-3 rounded-full " +
              (orbLive
                ? "bg-amber-400 animate-pulse"
                : "bg-neutral-600")
            }
          />
        </button>

        {/* Live transcript. */}
        <div
          className="min-h-6 w-full px-2 text-center font-mono text-[14px] leading-relaxed"
          aria-live="polite"
        >
          {transcript ? (
            <>
              {voice.draft}
              {voice.interim && (
                <span className="text-neutral-500">{voice.interim}</span>
              )}
            </>
          ) : (
            <span className="text-neutral-600">…</span>
          )}
        </div>

        {voice.error && (
          <div className="w-full px-2 text-center text-xs text-rose-400">
            {voice.error}
          </div>
        )}

        <div className="w-full px-2 text-center font-mono text-[11px] text-neutral-600">
          {hint}
        </div>
      </div>
    </div>
  );
}