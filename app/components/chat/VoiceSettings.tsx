import type { Tts } from "~/lib/use-tts";
import type { AutoSend, VoicePrefs } from "~/lib/voice-settings";

/**
 * The voice settings drawer (shared chrome) — the ModelDrawer's
 * hidden-panel pattern: a `drawer-grid` 0fr→1fr animation (see
 * app.css) around the settings rows.
 *
 * Two scopes:
 *
 *  - "voice"     — the full conversation-mode set: engine, voice
 *                  picker + preview, speed, narrate, auto-send,
 *                  listen, interrupt, sounds, screen. Used by the
 *                  VoicePanel.
 *  - "playback"  — only what changes what you HEAR: engine, voice,
 *                  speed. Used by the PlaybackPanel (the ▶ on
 *                  messages); conversation-flow settings (auto-send,
 *                  barge-in…) are irrelevant while listening to a
 *                  message and stay out of the way.
 *
 * Setters are optional to keep the playback wiring small; the rows
 * that need them only render under the scope that uses them.
 */
export function VoiceSettings({
  open,
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
  scope = "voice",
}: {
  open: boolean;
  tts: Tts;
  prefs: VoicePrefs;
  setTtsVoice?: (v: string | null) => void;
  setTtsSpeed?: (v: number) => void;
  setNarrate?: (v: boolean) => void;
  setAutoSend?: (v: AutoSend) => void;
  setAutoListen?: (v: boolean) => void;
  setBargeIn?: (v: boolean) => void;
  setSounds?: (v: boolean) => void;
  setKeepAwake?: (v: boolean) => void;
  scope?: "voice" | "playback";
}) {
  const selectedVoice = prefs.ttsVoice ?? tts.defaultVoice ?? "";
  // Label of the picked voice (or the server default) — for the
  // engine status line; empty when the engine has no configured
  // voices at all (pure browser setup).
  const selectedVoiceLabel =
    tts.voices.find((v) => v.id === selectedVoice)?.label ?? "";
  const conversation = scope === "voice";

  const selectCls =
    "h-9 min-w-0 flex-1 appearance-none border border-neutral-800 bg-neutral-900 px-2 font-mono text-[13px] text-neutral-100 outline-none focus:border-neutral-600 disabled:opacity-60";

  return (
    <div className="drawer-grid" data-open={open ? "true" : "false"}>
      <div className="drawer-panel">
        <div className="border border-neutral-800 bg-neutral-950 p-2">
          <div className="flex flex-col gap-2 p-2">
            {/* Engine status: what is ACTUALLY speaking, not
                what is configured — the picker above keeps its
                Deepgram list through an outage, so this is the
                line that tells you you're on browser voices.
                The fallback self-heals (~2min, use-tts.ts);
                "offline" here is transient, and the amber
                color is the glance signal. */}
            {tts.engine && (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-widest text-neutral-500">
                  Engine
                </span>
                <span
                  className={
                    "font-mono text-[11px] " +
                    (tts.engine === "neural"
                      ? "text-emerald-300"
                      : "text-amber-300")
                  }
                >
                  {tts.engine === "neural"
                    ? `Deepgram Aura${selectedVoiceLabel ? ` — ${selectedVoiceLabel}` : ""}`
                    : "browser voices — neural offline, retrying"}
                </span>
              </div>
            )}
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-widest text-neutral-500">
                Voice
              </span>
              <select
                value={selectedVoice}
                onChange={(e) => setTtsVoice?.(e.target.value)}
                disabled={tts.voices.length === 0}
                className={selectCls}
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
                    speed: prefs.ttsSpeed,
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
                Speed
              </span>
              <select
                value={String(prefs.ttsSpeed)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isNaN(v)) setTtsSpeed?.(v);
                }}
                className={selectCls}
              >
                <option value="0.8">Slow — 0.8×</option>
                <option value="0.9">Relaxed — 0.9×</option>
                <option value="1">Normal — 1×</option>
                <option value="1.15">Brisk — 1.15×</option>
                <option value="1.3">Fast — 1.3×</option>
              </select>
            </label>

            {conversation && (
              <>
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-widest text-neutral-500">
                    Narrate
                  </span>
                  <select
                    value={prefs.narrate ? "on" : "off"}
                    onChange={(e) => setNarrate?.(e.target.value === "on")}
                    className={selectCls}
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
                    onChange={(e) => setAutoSend?.(e.target.value as AutoSend)}
                    className={selectCls}
                  >
                    <option value="fast">Fast — 1s review window</option>
                    <option value="normal">Normal — 2.5s</option>
                    <option value="slow">Slow — 5s</option>
                    <option value="manual">Manual — I tap Send</option>
                  </select>
                </label>

                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-widest text-neutral-500">
                    Listen
                  </span>
                  <select
                    value={prefs.autoListen ? "auto" : "tap"}
                    onChange={(e) => setAutoListen?.(e.target.value === "auto")}
                    className={selectCls}
                  >
                    <option value="auto">Auto — mic opens after each reply</option>
                    <option value="tap">Tap to talk — pause between turns</option>
                  </select>
                </label>

                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-widest text-neutral-500">
                    Interrupt
                  </span>
                  <select
                    value={prefs.bargeIn ? "speak" : "tap"}
                    onChange={(e) => setBargeIn?.(e.target.value === "speak")}
                    className={selectCls}
                  >
                    <option value="tap">Tap the orb to interrupt</option>
                    <option value="speak">Just speak — mic stays open (headphones)</option>
                  </select>
                </label>

                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-widest text-neutral-500">
                    Sounds
                  </span>
                  <select
                    value={prefs.sounds ? "on" : "off"}
                    onChange={(e) => setSounds?.(e.target.value === "on")}
                    className={selectCls}
                  >
                    <option value="on">On — tones when mic opens / sent</option>
                    <option value="off">Silent</option>
                  </select>
                </label>

                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="w-24 shrink-0 font-mono text-[10px] uppercase tracking-widest text-neutral-500">
                    Screen
                  </span>
                  <select
                    value={prefs.keepAwake ? "on" : "off"}
                    onChange={(e) => setKeepAwake?.(e.target.value === "on")}
                    className={selectCls}
                  >
                    <option value="on">Keep on during voice mode</option>
                    <option value="off">Allow sleep</option>
                  </select>
                </label>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The ⚙ (sliders) toggle button shared by the voice and
 *  playback panels. */
export function SettingsToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label="Voice settings"
      className={
        "inline-flex h-7 w-7 items-center justify-center border border-neutral-800 active:bg-neutral-800 " +
        (open ? "text-amber-300" : "text-neutral-400")
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
  );
}
