import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Text-to-speech for agent replies, via speechSynthesis. The
 * enabled state is persisted to localStorage so the choice sticks
 * across visits — this is a phone tool; nobody wants to re-enable
 * narration every time they reopen the app.
 *
 * The hook is transport-only: it exposes speak()/cancel() and the
 * toggle. The ChatView decides *what* to speak (completed sentences
 * of agent text messages as they stream).
 *
 * Notes:
 * - The enabled state is read in an effect, not the state
 *   initializer, so SSR and hydration agree (server always renders
 *   "off"; the client flips it on after mount).
 * - iOS only lets speech start from a user gesture; the toggle
 *   click is that gesture, and subsequent speak() calls are fine.
 * - Turning the toggle off cancels whatever is mid-utterance.
 */

const STORAGE_KEY = "voir:tts";

export interface Tts {
  supported: boolean;
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  /** Speak text (no-op when disabled or unsupported). */
  speak: (text: string) => void;
  /** Drop the utterance queue, including anything mid-speech. */
  cancel: () => void;
}

export function useSpeechSynthesis(): Tts {
  const [enabled, setEnabledState] = useState(false);
  // Detected post-mount, not during render: SSR renders without
  // the toggle and hydration must agree (see use-speech-recognition
  // for the same reasoning).
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported("speechSynthesis" in window);
  }, []);

  // Post-mount read (see header comment). One frame of "off" is
  // imperceptible next to a full page load.
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "1") {
        setEnabledState(true);
      }
    } catch {
      // Private mode et al. — persistence is best-effort.
    }
  }, []);

  const cancel = useCallback(() => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
  }, []);

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

  // speak() must consult the *current* enabled value even when
  // called from an effect that captured an older render's object.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const speak = useCallback((text: string) => {
    if (!enabledRef.current || !("speechSynthesis" in window) || !text) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = navigator.language;
    window.speechSynthesis.speak(u);
  }, []);

  // Leaving the chat must not leave a reply talking over the
  // folder list.
  useEffect(() => cancel(), [cancel]);

  return { supported, enabled, setEnabled, speak, cancel };
}