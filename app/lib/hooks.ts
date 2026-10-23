import { useState, useEffect, useRef, useCallback } from "react";
import type { ActivityRow, SessionStatus } from "~/lib/chat-types";

/**
 * POST a status transition to /api/session-status. Fire-and-
 * forget: callers update optimistically and the snapshot poll
 * confirms within its interval. Not a hook — it lives here
 * because this is the client-side utilities module.
 */
export function postSessionStatus(
  folder: string,
  sessionId: string,
  status: SessionStatus | "none",
): void {
  void fetch("/api/session-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder, sessionId, status }),
  }).catch(() => {
    // The next poll re-syncs; a failed toggle self-heals.
  });
}

const SESSION_STATUS_POLL_MS = 2000;

/**
 * The "Working on" rows, polled live (docs/session-status.md).
 *
 * Fetches GET /api/session-status every 2s while the document
 * is visible — the snapshot is a few hundred bytes and the
 * interesting transitions (working → waiting) are minutes
 * apart, so a poll beats a global SSE channel (which would need
 * a new server-side broadcast surface for ~0s freshness nobody
 * needs). Seeded from the root loader so the first paint is
 * server-rendered; the seed re-applies on navigation.
 *
 * `unstar` removes a row optimistically and POSTs "none" —
 * the one manual cleanup act of the curate-in model.
 */
export function useSessionStatus(seed?: ActivityRow[]) {
  const [rows, setRows] = useState<ActivityRow[]>(seed ?? []);
  const visible = usePageVisible();

  // Re-seed when the loader hands us fresh data (navigation).
  useEffect(() => {
    if (seed) setRows(seed);
  }, [seed]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/session-status");
        if (!res.ok) return;
        const data = (await res.json()) as { sessions?: ActivityRow[] };
        if (!cancelled && Array.isArray(data.sessions)) {
          setRows(data.sessions);
        }
      } catch {
        // Server restart / flaky network: the next tick retries.
      }
    };
    void tick(); // immediate on (re)becoming visible
    const id = setInterval(tick, SESSION_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [visible]);

  const unstar = useCallback((row: ActivityRow) => {
    setRows((rs) =>
      rs.filter(
        (r) => !(r.sessionId === row.sessionId && r.folder === row.folder),
      ),
    );
    postSessionStatus(row.folder, row.sessionId, "none");
  }, []);

  return { rows, unstar };
}

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
