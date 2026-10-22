// Voir service worker.
//
// Today: the minimum for installability (Android/Chrome require a
// fetch-handling SW) plus a network-first navigation fallback that
// serves the offline page when the server is unreachable. The app
// shell is never cached — Vite fingerprints assets and the
// transcript always comes live from the server, so there is no
// staleness to manage. API calls and the SSE stream are ignored
// entirely; reconnection is handled in the page (ChatView).
//
// Down the line: Web Push notifications for AI-initiated chats
// (agent prompts fired from cron/events) will land here as a
// `push` event handler plus a `notificationclick` focus handler.
// The manifest/SW wiring in this file is the prerequisite for it.

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