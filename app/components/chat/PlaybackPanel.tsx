import { useEffect, useState } from "react";
import type { Tts } from "~/lib/use-tts";
import type { VoicePrefs } from "~/lib/voice-settings";
import { VoiceSettings, SettingsToggle } from "./VoiceSettings";

/**
 * Retro playback panel — while a message's ▶ narration runs
 * (ChatView's playMessage), this compact strip sits above the
 * composer: what's playing, Stop, and the voice settings
 * (engine, voice picker, speed) — the playback scope of the
 * shared VoiceSettings. Changing voice or speed restarts the
 * playback with the new setting (the utterance queue is
 * pre-scheduled; restarting is the honest way to apply it) — the
 * hint line says so.
 *
 * The composer stays mounted below (a draft mid-typing must not
 * be churned) — unlike voice mode, which owns the whole input
 * area. Auto-dismisses when playback drains (playingId clears),
 * and Esc stops.
 */
export function PlaybackPanel({
  tts,
  prefs,
  excerpt,
  onVoiceChange,
  onSpeedChange,
  onStop,
}: {
  tts: Tts;
  prefs: VoicePrefs;
  /** One-line excerpt of the playing message (ChatView computes). */
  excerpt: string;
  /** Persist the new pick AND restart the playback with it. */
  onVoiceChange: (v: string | null) => void;
  onSpeedChange: (v: number) => void;
  onStop: () => void;
}) {
  // Settings open by default — editing them is the point of the
  // panel; collapse to a bare status line with the ⚙ toggle.
  const [settingsOpen, setSettingsOpen] = useState(true);

  // Esc stops playback (the voice panel's Esc exits voice mode —
  // same key, same "stop what's happening" contract).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onStop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStop]);

  return (
    <div className="relative shrink-0 border-t border-neutral-800 bg-neutral-950 px-3 pb-2 pt-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {/* Control row: status + Settings + Stop. */}
        <div className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-wider text-emerald-300">
            Playing — {excerpt || "message"}
          </span>
          <SettingsToggle
            open={settingsOpen}
            onToggle={() => setSettingsOpen((v) => !v)}
          />
          <button
            type="button"
            onClick={onStop}
            className="border border-neutral-800 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-neutral-400 active:bg-neutral-800"
          >
            ■ Stop
          </button>
        </div>

        <VoiceSettings
          open={settingsOpen}
          scope="playback"
          tts={tts}
          prefs={prefs}
          setTtsVoice={onVoiceChange}
          setTtsSpeed={onSpeedChange}
        />

        {settingsOpen && (
          <div className="w-full px-2 pb-1 text-center font-mono text-[11px] text-neutral-600">
            Changing voice or speed restarts the playback from the top.
          </div>
        )}
      </div>
    </div>
  );
}
