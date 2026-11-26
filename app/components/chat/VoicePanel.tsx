/**
 * Voice conversation mode panel — replaces the composer while
 * active. A big mic orb shows the loop's phase, the live
 * transcript renders underneath, and the orb's tap is contextual.
 * The control row has Pause (mute the mic without leaving),
 * a settings drawer (voice picker with preview, reply narration,
 * auto-send timing — the ModelDrawer's hidden-panel pattern),
 * and Done.
 *
 * Esc exits voice mode.
 */
import { useEffect, useState } from "react";
import type { VoiceHandle } from "~/lib/use-voice";
import { REVIEW_MS } from "~/lib/use-voice";
import type { Tts } from "~/lib/use-tts";
import type { AutoSend, VoicePrefs } from "~/lib/voice-settings";
import { VoiceSettings, SettingsToggle } from "./VoiceSettings";

const STATUS: Record<VoiceHandle["phase"], string> = {
  off: "",
  connecting: "Connecting mic…",
  listening: "Listening…",
  reviewing: "Sending…",
  sending: "Sending…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

export function VoicePanel({
  voice,
  tts,
  prefs,
  setTtsVoice,
  setTtsSpeed,
  setNarrate,
  setAutoSend,
  setAutoListen,
  setBargeIn,
  setSounds,
  setKeepAwake,
}: {
  voice: VoiceHandle;
  tts: Tts;
  prefs: VoicePrefs;
  setTtsVoice: (v: string | null) => void;
  setTtsSpeed: (v: number) => void;
  setNarrate: (v: boolean) => void;
  setAutoSend: (v: AutoSend) => void;
  setAutoListen: (v: boolean) => void;
  setBargeIn: (v: boolean) => void;
  setSounds: (v: boolean) => void;
  setKeepAwake: (v: boolean) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const autoSendMs =
    prefs.autoSend === "fast"
      ? 1000
      : prefs.autoSend === "slow"
        ? 5000
        : prefs.autoSend === "manual"
          ? 0
          : REVIEW_MS;
  const remaining =
    voice.phase === "reviewing" && voice.reviewStartedAt && autoSendMs > 0
      ? Math.max(
          0,
          Math.ceil((autoSendMs - (Date.now() - voice.reviewStartedAt)) / 1000),
        )
      : null;

  const orbLive =
    !voice.paused &&
    (voice.phase === "listening" || voice.phase === "reviewing");
  const manualReview = voice.phase === "reviewing" && autoSendMs === 0;

  const hint = voice.paused
    ? "Mic paused — tap the orb or Resume to keep talking"
    : voice.phase === "listening"
      ? "Pause when you're done — it sends itself. Tap Done to exit."
      : manualReview
        ? "Ready to send — or keep talking to continue"
        : voice.phase === "reviewing"
          ? `Sending in ${remaining}s — tap the orb to edit, or keep talking`
          : voice.phase === "thinking" || voice.phase === "speaking"
            ? "Tap the orb to interrupt and keep talking"
            : "";

  const transcript = voice.draft || voice.interim;

  return (
    <div className="relative shrink-0 border-t border-neutral-800 bg-neutral-950 px-3 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {/* Control row: status + Pause / Settings / Done. */}
        <div className="flex w-full items-center gap-2">
          <span
            className={
              "min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-wider " +
              (voice.paused
                ? "text-neutral-500"
                : orbLive
                  ? "text-amber-300"
                  : "text-neutral-500")
            }
          >
            {voice.paused
              ? "Paused"
              : STATUS[voice.phase] +
                (remaining !== null && remaining > 0 ? ` in ${remaining}s` : "")}
          </span>
          <button
            type="button"
            onClick={() => (voice.paused ? voice.resume() : voice.pause())}
            className="border border-neutral-800 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-neutral-400 active:bg-neutral-800"
          >
            {voice.paused ? "Resume" : "Pause"}
          </button>
          <SettingsToggle
            open={settingsOpen}
            onToggle={() => setSettingsOpen((v) => !v)}
          />
          <button
            type="button"
            onClick={voice.stop}
            className="border border-neutral-800 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-neutral-400 active:bg-neutral-800"
          >
            Done
          </button>
        </div>

        {/* Settings drawer — the shared VoiceSettings (also the
            PlaybackPanel's), full conversation scope. */}
        <VoiceSettings
          open={settingsOpen}
          scope="voice"
          tts={tts}
          prefs={prefs}
          setTtsVoice={setTtsVoice}
          setTtsSpeed={setTtsSpeed}
          setNarrate={setNarrate}
          setAutoSend={setAutoSend}
          setAutoListen={setAutoListen}
          setBargeIn={setBargeIn}
          setSounds={setSounds}
          setKeepAwake={setKeepAwake}
        />

        {/* Mic orb — the contextual tap target. */}
        <button
          type="button"
          aria-label={
            voice.paused
              ? "Resume the microphone"
              : voice.phase === "reviewing"
                ? "Edit transcript before sending"
                : voice.phase === "thinking" || voice.phase === "speaking"
                  ? "Interrupt and speak"
                  : "Voice mode"
          }
          onClick={() => {
            // Every tap also nudges the audio context — Android
            // can suspend it mid-session (screen lock, tab switch)
            // and only a gesture lets us resume.
            voice.resumeAudio();
            if (voice.paused) {
              voice.resume();
              return;
            }
            if (voice.phase === "reviewing") voice.editNow();
            else if (voice.phase === "thinking" || voice.phase === "speaking")
              voice.bargeIn();
            else if (voice.phase !== "off" && voice.phase !== "connecting")
              voice.stop();
          }}
          className={
            "mx-auto flex h-16 w-16 select-none items-center justify-center rounded-full border transition-colors [touch-action:manipulation] " +
            (voice.paused
              ? "border-neutral-700 text-neutral-500"
              : orbLive
                ? "border-amber-400/60 text-amber-300"
                : "border-neutral-700 text-neutral-500")
          }
        >
          <span
            aria-hidden="true"
            className={
              "inline-block h-3 w-3 rounded-full " +
              (voice.paused
                ? "bg-neutral-600"
                : orbLive
                  ? "bg-amber-400 animate-pulse"
                  : "bg-neutral-600")
            }
          />
        </button>

        {/* Manual review: Send / Edit buttons. */}
        {manualReview && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={voice.sendNow}
              className="h-11 flex-1 border border-white bg-transparent text-sm font-semibold uppercase tracking-wider text-white active:bg-white/10"
            >
              Send
            </button>
            <button
              type="button"
              onClick={voice.editNow}
              className="h-11 flex-1 border border-neutral-700 bg-transparent text-sm font-semibold uppercase tracking-wider text-neutral-300 active:bg-white/10"
            >
              Edit
            </button>
          </div>
        )}

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

        <DebugLine voice={voice} />
      </div>
    </div>
  );
}

function DebugLine({ voice }: { voice: VoiceHandle }) {
  const [stats, setStats] = useState(() => voice.getStats());
  useEffect(() => {
    const id = setInterval(() => setStats(voice.getStats()), 500);
    return () => clearInterval(id);
  }, [voice]);
  return (
    <div className="w-full px-2 text-center font-mono text-[10px] text-neutral-700">
      {stats.ws} · ctx:{stats.ctx} · {stats.frames}f/{Math.round(stats.bytes / 1024)}kb ·
      last:{stats.lastEvent || "-"}
    </div>
  );
}