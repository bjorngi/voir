import { useCallback, useEffect, useState } from "react";

/**
 * Web Push client state for the bell toggle (docs/two-way.md).
 *
 *   unknown     — capability check hasn't run yet (SSR-safe initial)
 *   unsupported — this browser can't do push at all
 *   disabled    — server has no VAPID keys; feature off
 *   off         — capable, no subscription on this device
 *   denied      — the user (or the OS) blocked notification permission
 *   on          — subscribed; pushes will arrive with voir closed
 *
 * The heavy lifting lives in the service worker (public/sw.js);
 * this hook only manages the subscription lifecycle against
 * /api/notify/*.
 */

export type PushState =
  | "unknown"
  | "unsupported"
  | "disabled"
  | "off"
  | "denied"
  | "on";

interface NotifyConfig {
  publicKey?: string;
  disabled?: boolean;
}

export function usePush() {
  const [state, setState] = useState<PushState>("unknown");

  useEffect(() => {
    let alive = true;
    async function probe() {
      if (
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      ) {
        setState("unsupported");
        return;
      }
      try {
        const res = await fetch("/api/notify/config");
        const cfg: NotifyConfig = await res.json();
        if (cfg.disabled) {
          setState("disabled");
          return;
        }
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          setState("on");
          return;
        }
        setState(Notification.permission === "denied" ? "denied" : "off");
      } catch {
        // Config endpoint unreachable — don't lie, default to off.
        if (alive) setState("off");
      }
    }
    void probe();
    return () => {
      alive = false;
    };
  }, []);

  const enable = useCallback(async () => {
    try {
      const res = await fetch("/api/notify/config");
      const cfg: NotifyConfig = await res.json();
      if (!cfg.publicKey) {
        setState("disabled");
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState("denied");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(cfg.publicKey),
      });
      await fetch("/api/notify/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      setState("on");
    } catch (err) {
      console.error("[push] subscribe failed", err);
      setState("off");
    }
  }, []);

  const disable = useCallback(async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/notify/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState("off");
    } catch (err) {
      console.error("[push] unsubscribe failed", err);
    }
  }, []);

  const toggle = useCallback(() => {
    if (state === "on") void disable();
    else if (state === "off" || state === "denied") void enable();
    // disabled/unsupported: nothing to do; the button is hidden anyway.
  }, [state, enable, disable]);

  return { state, toggle };
}

/** VAPID keys are base64url; pushManager wants raw bytes. */
function urlB64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buf = new ArrayBuffer(raw.length);
  const arr = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}