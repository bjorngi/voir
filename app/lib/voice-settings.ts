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
  narrate: boolean;
  autoSend: AutoSend;
}

const DEFAULTS: VoicePrefs = {
  ttsVoice: null,
  narrate: true,
  autoSend: "normal",
};

export function useVoicePrefs(): {
  prefs: VoicePrefs;
  setTtsVoice: (v: string | null) => void;
  setNarrate: (v: boolean) => void;
  setAutoSend: (v: AutoSend) => void;
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
        narrate: typeof parsed.narrate === "boolean" ? parsed.narrate : p.narrate,
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
    setNarrate: (v) => persist({ ...prefs, narrate: v }),
    setAutoSend: (v) => persist({ ...prefs, autoSend: v }),
  };
}