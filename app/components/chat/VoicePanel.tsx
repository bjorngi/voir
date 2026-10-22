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
  setNarrate,
  setAutoSend,
}: {
  voice: VoiceHandle;
  tts: Tts;
  prefs: VoicePrefs;
  setTtsVoice: (v: string | null) => void;
  setNarrate: (v: boolean) => void;
  setAutoSend: (v: AutoSend) => void;
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
  const selectedVoice = prefs.ttsVoice ?? tts.defaultVoice ?? "";

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
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
            aria-label="Voice settings"
            className={
              "inline-flex h-7 w-7 items-center justify-center border border-neutral-800 active:bg-neutral-800 " +
              (settingsOpen ? "text-amber-300" : "text-neutral-400")
            }
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="4" y1="21" x2="4" y2="14" />
              <line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" />
              <line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" />
              <line x1="9" y1="8" x2="15" y2="8" />
              <line x1="17" y1="16" x2="23" y2="16" />
            </svg>
          </button>
          <button
            type="button"
            onClick={voice.stop}
            className="border border-neutral-800 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-neutral-400 active:bg-neutral-800"
          >
            Done
          </button>
        </div>

        {/* Settings drawer — the ModelDrawer's hidden-panel pattern:
            grid-template-rows 0fr→1fr animation (see app.css). */}
        <div className="drawer-grid" data-open={settingsOpen ? "true" : "false"}>
          <div className="drawer-panel">
            <div className="border border-neutral-800 bg-neutral-950 p-2">
              <div className="flex flex-col gap-2 p-2">
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-widest text-neutral-500">
                    Voice
                  </span>
                  <select
                    value={selectedVoice}
                    onChange={(e) => setTtsVoice(e.target.value)}
                    disabled={tts.voices.length === 0}
                    className="h-9 min-w-0 flex-1 appearance-none border border-neutral-800 bg-neutral-900 px-2 font-mono text-[13px] text-neutral-100 outline-none focus:border-neutral-600 disabled:opacity-60"
                  >
                    {tts.voices.length === 0 && (
                      <option value="">Browser voices</option>
                    )}
                    {tts.voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() =>
                      tts.speak("Hi, this is how I will read the replies.", {
                        force: true,
                        voice: selectedVoice || undefined,
                      })
                    }
                    disabled={tts.voices.length === 0}
                    className="h-9 shrink-0 border border-neutral-800 px-3 font-mono text-[11px] uppercase tracking-wider text-neutral-300 active:bg-neutral-800 disabled:opacity-60"
                  >
                    ▶ Preview
                  </button>
                </label>

                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-widest text-neutral-500">
                    Narrate
                  </span>
                  <select
                    value={prefs.narrate ? "on" : "off"}
                    onChange={(e) => setNarrate(e.target.value === "on")}
                    className="h-9 min-w-0 flex-1 appearance-none border border-neutral-800 bg-neutral-900 px-2 font-mono text-[13px] text-neutral-100 outline-none focus:border-neutral-600"
                  >
                    <option value="on">Speak replies aloud</option>
                    <option value="off">Silent (text only)</option>
                  </select>
                </label>

                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-widest text-neutral-500">
                    Auto-send
                  </span>
                  <select
                    value={prefs.autoSend}
                    onChange={(e) => setAutoSend(e.target.value as AutoSend)}
                    className="h-9 min-w-0 flex-1 appearance-none border border-neutral-800 bg-neutral-900 px-2 font-mono text-[13px] text-neutral-100 outline-none focus:border-neutral-600"
                  >
                    <option value="fast">Fast — 1s review window</option>
                    <option value="normal">Normal — 2.5s</option>
                    <option value="slow">Slow — 5s</option>
                    <option value="manual">Manual — I tap Send</option>
                  </select>
                </label>
              </div>
            </div>
          </div>
        </div>

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