import { useEffect, useState } from "react";

/**
 * Voice-conversation preferences, persisted in localStorage —
 * the voice panel's settings drawer edits these:
 *
 *   ttsVoice   — narration voice id (null = server default)
 *   narrate    — whether voice mode narrates replies (default on;
 *                the global "Read aloud" header toggle is separate)
 *   autoSend   — the review-window behavior before a spoken
 *                message auto-sends
 *
 * Read post-mount (SSR/hydration agreement), like the tts toggle.
 */

const PREFS_KEY = "voir:voice-prefs";

export type AutoSend = "fast" | "normal" | "slow" | "manual";

export const AUTO_SEND_MS: Record<AutoSend, number> = {
  fast: 1000,
  normal: 2500,
  slow: 5000,
  manual: 0,
};

export interface VoicePrefs {
  ttsVoice: string | null;
  ttsSpeed: number;
  narrate: boolean;
  autoSend: AutoSend;
  /** Mic re-opens automatically after each reply (off = pause
   *  between turns, tap the orb to talk). */
  autoListen: boolean;
  /** Earcons — subtle tones when the mic opens and on send. */
  sounds: boolean;
  /** Wake Lock while voice mode is active — the phone screen
   *  staying on is what keeps a hands-free conversation alive. */
  keepAwake: boolean;
  /** Mic stays live during narration so you can interrupt by
   *  voice. Use headphones — on speaker the narration feeds back
   *  into the mic. */
  bargeIn: boolean;
}

const DEFAULTS: VoicePrefs = {
  ttsVoice: null,
  ttsSpeed: 1,
  narrate: true,
  autoSend: "normal",
  autoListen: true,
  sounds: true,
  keepAwake: true,
  bargeIn: false,
};

export function useVoicePrefs(): {
  prefs: VoicePrefs;
  setTtsVoice: (v: string | null) => void;
  setTtsSpeed: (v: number) => void;
  setNarrate: (v: boolean) => void;
  setAutoSend: (v: AutoSend) => void;
  setAutoListen: (v: boolean) => void;
  setSounds: (v: boolean) => void;
  setKeepAwake: (v: boolean) => void;
  setBargeIn: (v: boolean) => void;
} {
  const [prefs, setPrefs] = useState<VoicePrefs>(DEFAULTS);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<VoicePrefs>;
      setPrefs((p) => ({
        ttsVoice:
          typeof parsed.ttsVoice === "string" ? parsed.ttsVoice : p.ttsVoice,
        ttsSpeed:
          typeof parsed.ttsSpeed === "number" && parsed.ttsSpeed >= 0.7 && parsed.ttsSpeed <= 1.5
            ? parsed.ttsSpeed
            : p.ttsSpeed,
        narrate: typeof parsed.narrate === "boolean" ? parsed.narrate : p.narrate,
        autoListen:
          typeof parsed.autoListen === "boolean" ? parsed.autoListen : p.autoListen,
        sounds: typeof parsed.sounds === "boolean" ? parsed.sounds : p.sounds,
        keepAwake: typeof parsed.keepAwake === "boolean" ? parsed.keepAwake : p.keepAwake,
        bargeIn: typeof parsed.bargeIn === "boolean" ? parsed.bargeIn : p.bargeIn,
        autoSend:
          parsed.autoSend === "fast" ||
          parsed.autoSend === "slow" ||
          parsed.autoSend === "manual"
            ? parsed.autoSend
            : parsed.autoSend === "normal"
              ? "normal"
              : p.autoSend,
      }));
    } catch {
      // Corrupt prefs / private mode — defaults are fine.
    }
  }, []);

  const persist = (next: VoicePrefs) => {
    setPrefs(next);
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {}
  };

  return {
    prefs,
    setTtsVoice: (v) => persist({ ...prefs, ttsVoice: v }),
    setTtsSpeed: (v) => persist({ ...prefs, ttsSpeed: v }),
    setNarrate: (v) => persist({ ...prefs, narrate: v }),
    setAutoSend: (v) => persist({ ...prefs, autoSend: v }),
    setAutoListen: (v) => persist({ ...prefs, autoListen: v }),
    setSounds: (v) => persist({ ...prefs, sounds: v }),
    setKeepAwake: (v) => persist({ ...prefs, keepAwake: v }),
    setBargeIn: (v) => persist({ ...prefs, bargeIn: v }),
  };
}