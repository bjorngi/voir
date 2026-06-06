import { useState, useEffect, useRef } from "react";

/**
 * Track whether the page is currently visible. SSE/EventSource gets
 * paused when the tab/app is backgrounded on mobile; we don't need to
 * poll, but we should know.
 */
export function usePageVisible() {
  const [visible, setVisible] = useState(
    typeof document !== "undefined" ? !document.hidden : true,
  );
  useEffect(() => {
    const onVis = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  return visible;
}

/**
 * Auto-scroll to the bottom of a container when new content is added.
 *
 * The first time the effect runs (typically on mount) it scrolls all
 * the way to the bottom regardless of where the user is — opening a
 * chat should land on the latest message. Subsequent runs only
 * scroll if the user is already near the bottom (within 80px), so
 * we don't yank them away from older content they're reading.
 *
 * Note: `el.scrollTop` survives DOM updates, but `scrollHeight`
 * grows when new children are added. After a content update,
 * `scrollHeight - scrollTop - clientHeight` is the size of the new
 * content (not the user's pre-update distance from the bottom).
 * We track the previous scrollHeight in a ref so we can decide
 * based on the pre-update position.
 * Returns a ref to attach.
 */
export function useAutoScroll<T extends HTMLElement>(deps: unknown[]) {
  const ref = useRef<T>(null);
  const firstRun = useRef(true);
  const prevScrollHeight = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (firstRun.current) {
      el.scrollTop = el.scrollHeight;
      prevScrollHeight.current = el.scrollHeight;
      firstRun.current = false;
      return;
    }
    // Distance from the bottom at the time the previous effect ran.
    // If the user was within 80px then, follow new content.
    const wasNearBottom =
      prevScrollHeight.current - el.scrollTop - el.clientHeight < 80;
    if (wasNearBottom) el.scrollTop = el.scrollHeight;
    prevScrollHeight.current = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}
