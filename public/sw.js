// Voir service worker.
//
// Two jobs:
// 1. The minimum for installability (Android/Chrome require a
//    fetch-handling SW) plus a network-first navigation fallback
//    that serves the offline page when the server is unreachable.
//    The app shell is never cached — Vite fingerprints assets and
//    the transcript always comes live from the server, so there is
//    no staleness to manage. API calls and the SSE stream are
//    ignored entirely; reconnection is handled in the page
//    (ChatView).
// 2. Web Push for machine-initiated chats (docs/two-way.md):
//    `push` shows the notification, `notificationclick` focuses
//    (or opens) the conversation, `pushsubscriptionchange`
//    re-subscribes with a fresh endpoint.

const VERSION = "voir-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.add(OFFLINE_URL)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Only same-origin document navigations. Everything else —
  // Vite assets, fonts, API calls, the SSE stream — goes to the
  // network untouched.
  if (request.mode !== "navigate") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(request).catch(() =>
      caches
        .match(OFFLINE_URL)
        .then((cached) => cached || Response.error()),
    ),
  );
});

// -- Web Push -----------------------------------------------------------
//
// Payload shape (≤ 4 KB, encrypted end-to-end by the web-push
// library per subscription): { title, body, url, tag }.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Malformed payload: still show something. Chrome requires a
    // notification per pushed event or it shows its own "site
    // updated in background" fallback.
    data = { title: "Voir" };
  }
  const url = data.url ? new URL(data.url, self.location.origin).href : "/";
  // Native-style options: timestamp orders the notification,
  // the maskable icon survives Android's circle crop, and when
  // the payload carries a session the notification offers an
  // inline reply (type: "text" — messaging-app behavior on
  // Android Chrome; desktop shows buttons, iOS ignores actions).
  const options = {
    body: data.body || "",
    tag: data.tag,
    renotify: true,
    icon: "/icons/icon-maskable-512.png",
    badge: "/icons/icon-maskable-512.png",
    timestamp: Date.now(),
    data: { url, folder: data.folder, sessionId: data.sessionId },
  };
  if (data.folder && data.sessionId) {
    options.actions = [
      { action: "open", title: "Open chat" },
      {
        action: "reply",
        title: "Reply",
        type: "text",
        placeholder: "Reply to pi…",
      },
    ];
  }
  event.waitUntil(self.registration.showNotification(data.title || "Voir", options));
});

self.addEventListener("notificationclick", (event) => {
  // Inline reply: the user typed text straight into the shade.
  // POST it to the session (no app launch — that's the native
  // part) and confirm with a quiet follow-up notification.
  if (event.action === "reply" && event.reply) {
    const { folder, sessionId } = event.notification.data || {};
    const text = event.reply;
    event.waitUntil(
      (async () => {
        let ok = false;
        if (folder && sessionId) {
          try {
            const res = await fetch(`/api/sessions/${sessionId}/action`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ folder, kind: "send", text }),
            });
            ok = res.ok;
          } catch {
            ok = false;
          }
        }
        await self.registration.showNotification(
          ok ? "Reply sent" : "Reply failed",
          {
            body: ok
              ? "pi is working — check the chat for the answer."
              : "Could not deliver — open the chat and resend.",
            tag: `voir:${sessionId}`,
            renotify: true,
            icon: "/icons/icon-maskable-512.png",
            data: { url: event.notification.data?.url || "/" },
          },
        );
      })(),
    );
    return;
  }

  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      // Focus an open window already sitting on that conversation;
      // otherwise open one. (A window on a different view is not
      // navigated — the user may be mid-conversation elsewhere.)
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        if (new URL(client.url).href === url && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});

// The push service rotated our endpoint (or the subscription was
// dropped). Best effort: ask voir for the VAPID key, re-subscribe,
// and register the new endpoint. The old one is replaced
// server-side by endpoint dedup — and if the old endpoint simply
// expired, the next push delivery would have cleaned it up.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch("/api/notify/config");
        const cfg = await res.json();
        if (!cfg.publicKey) return;
        const reg = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8(cfg.publicKey),
        });
        await fetch("/api/notify/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reg.toJSON()),
        });
      } catch {
        // voir unreachable or push disabled — nothing to salvage.
      }
    })(),
  );
});

function urlB64ToUint8(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}