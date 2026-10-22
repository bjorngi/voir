# Two-way conversations: machine-initiated chats + Web Push (design)

**Status:** Phase 1 **implemented** (see "Phase 1 — as built" below);
Phase 2/3 remain design. Real-device verification pending.
**Scope:** let an external process (curl today; cron/HA later) start a
conversation that appears in Voir, and notify the user via Web Push —
so the user can open Voir and reply, and the agent continues with full
context. The reply half already works; this document designs the
missing "agent-side initiates" half plus the notification channel.

## Goal

```
today:   human ──▶ voir ──▶ pi-acp ──▶ pi        (human always speaks first)

goal:    machine ──POST──▶ voir ──▶ pi-acp ──▶ pi
         (cron, HA, curl)      │
                                 │ creates session, seeds first turn
                                 ▼
                          Web Push ──▶ phone/browser
                                 │
human ◀──tap── notification       │
   └──────▶ voir ──▶ conversation ──▶ reply ──▶ pi continues
```

Two-way means: *the same conversation* is writable from both sides —
the machine seeds it, the human continues it, pi keeps one session
thread across both.

Non-goals (for now): OAuth on the inbox endpoint, per-folder
subscription preferences, k8s deployment specifics (noted as
considerations), changes to pi-acp or the ACP protocol.

## Current state (verified in this repo)

- Sessions are only created from the browser: `chat.tsx` action
  (`intent: "new"`) → `sessionManager.createSession()` →
  `client.newSession()` (`session/new` JSON-RPC). There is no
  machine-reachable endpoint that creates a session.
- ACP is client-driven: the agent can never push a *new* session at
  the client. Everything agent → client flows as `session/update`
  notifications for sessions the client already knows
  (`sessions.server.ts` → `handleSessionUpdate`).
- voir's browser event stream is per-session only
  (`api.stream.tsx` SSE, subscribed via `sessionManager.subscribe`).
  Folder and session lists are loaded at page navigation; nothing
  tells an open tab that a *new* session appeared elsewhere.
- Notification plumbing: none. No service worker, no manifest, no
  `public/` dir, no push subscriptions, no Notification API use.
- pi-acp persists pi sessions to `~/.pi/agent/sessions/*.jsonl` and
  supports `session/list` (filtered by cwd) and `session/load`
  (replays the transcript as `session/update` notifications). Both
  are already wired in voir (`listSessions`/`loadSession`).
  → A headless `pi` run on the same host with the same cwd and the
  same `~/.pi/agent` dir produces a session voir can list and load.
- voir has no database; durable state so far lives on the filesystem
  (e.g. timeline snapshots via `timeline.server.ts`).

## Conversation instantiation

ACP requires the client to create sessions, so "pi instantiates"
must be mediated by voir. Three modes:

### Mode 1 — agent-mediated seed (recommended default)

The machine POSTs a prompt; voir creates a fresh session and sends
the prompt as the first user turn; pi processes it and its reply is
the conversation's first agent message.

```
POST /api/inbox
Content-Type: application/json
X-Voir-Token: <VOIR_INBOX_TOKEN>

{
  "folder": "/home/bjorn/code/infra",
  "prompt": "[from: manual curl] Summarize today's hiet checkup report.",
  "notify": "on-settle",          // "on-create" | "on-settle" | "both"
  "title": "hiet checkup follow-up"   // optional, defaults like UI sessions
}

→ 201 { "sessionId": "…", "folder": "…" }
```

Flow: `createSession(folder, title)` → `sendMessage(folder, sessionId,
text)` → push at the chosen moment → user taps → opens
`/f/<folder>/<sessionId>`.

- The prompt is prefixed with an origin marker (`[from: …]`) so
  both the user and pi can see provenance; pi treats it as an
  ordinary user turn.
- Push on **settle** (default) carries pi's reply excerpt as the
  notification body — "you have an answer waiting".
- Push on **create** lets the user watch the turn stream live.
- Reuses `runPrompt`'s queueing semantics unchanged: seeding a
  session while others are busy just queues normally per session.

### Mode 2 — passthrough seed (machine message, no agent turn)

For cases where the machine wants to *say something to the user*
directly ("HA: dishwasher finished") without burning an agent turn.

Same endpoint with `"mode": "passthrough"` and `"prompt"` rendered as
a synthetic message in the transcript:

- voir appends a `ChatMessage` with `role: "user"`, styled as an
  *origin card* (new `kind`, e.g. `kind: "origin"`), attributed via
  the origin marker — not impersonating the human.
- **Divergence caveat (accepted):** the message lives only in voir's
  in-memory transcript. It is not in pi's session file, so
  `session/load` replay from pi-acp will not contain it. Options:
  (a) accept — it's ephemeral context; (b) persist voir-side
  "injected messages" keyed by sessionId and re-inject after replay
  (small JSON file, same store as push subscriptions, see below).
  Decide before implementation.

The human replies → normal `session/prompt` → pi now has the origin
message as *its* first user turn (voir includes the passthrough text
in the first human reply, or sends it as a standalone queued turn —
decision point, see Open questions).

### Mode 3 — hand-off (pi created the session elsewhere)

The machine already *ran* pi headless (cron job, systemd, HA
webhook) in a registered folder's cwd; the session file exists in the
shared `~/.pi/agent/sessions`. voir adopts it:

```
POST /api/inbox/handoff
X-Voir-Token: <…>

{ "folder": "/home/bjorn/code/infra",
  "sessionId": "<pi session id>",          // or "latest": true to pick
  "title": "weekly HA review" }           //   the newest unseen session

→ 200 { "sessionId": "…", "loaded": true }
```

Flow: `loadSession(folder, sessionId)` (pi-acp replays the full
transcript via `session/update`) → push with the session title + a
one-line excerpt → user opens and continues *the same* conversation
with full context. The weekly HA review / daily hiet checkup cron
jobs are natural fits: today they push one-way summaries to the
phone; with hand-off they become conversations the user can reply to.

Hand-off requires the folder's pi-acp and the headless pi to share
the host (true on devbox; in k8s the overlay's PVC covers it) and the
cwd. `session/list` already filters by cwd, so `"latest": true` is
safe: it means "newest session in this folder I haven't shown yet".

### Why not have pi-acp push sessions at voir

The ACP direction is fixed (agent never initiates), and pi-acp
shouldn't grow voir-specific knowledge. voir owns the user-facing
model, so voir owns session adoption. The inbox endpoints are the
seam.

## Notification channel: Web Push

Chosen channel (works with the browser *closed*; the right fit for
"phone buzzes, tap, chat"). Complementary in-app affordances
(badges, global SSE) are Phase 2 and independent.

### Architecture

```
POST /api/inbox            ┌─ voir server ─────────────────────────┐
        │                  │                                        │
        ▼                  │  push-registry.server.ts               │
  sessionManager ──────────┼─▶ web-push.sendNotification()          │
  (turn settles / created) │     │  subscriptions: JSON file         │
                           │     ▼                                   │
                           └─ outbound HTTPS ──▶ browser push service
                                                     (Mozilla autopush /
                                                      Google FCM)
                                                          │
                                                          ▼
                                phone/browser: service worker `sw.js`
                                `push` event → showNotification
                                `notificationclick` → open conversation URL
```

- **Library:** [`web-push`](https://www.npmjs.com/package/web-push)
  (de-facto standard; handles VAPID + per-subscription encryption).
  Payload ≤ 4 KB — send `{ url, title, body, tag }`, nothing else.
- **VAPID keys:** generated once
  (`npx web-push generate-vapid-keys`), stored as env
  `VOIR_VAPID_PUBLIC_KEY` / `VOIR_VAPID_PRIVATE_KEY`.
  If absent → the feature is off (routes return 503); no silent
  failure. Public key reaches the client via `GET /api/push/config`
  (or a loader) for `pushManager.subscribe({ applicationServerKey })`.
- **Service worker:** `public/sw.js` (first file in voir's first
  `public/` dir; vite copies it to the build root, react-router-serve
  serves it statically). Handlers:
  - `push` → `self.registration.showNotification(title, { body, tag, data: { url } })`
  - `notificationclick` → `clients.matchClient({ url })` → focus, else `openWindow(url)`
  - `pushsubscriptionchange` → re-subscribe + POST new subscription
  - registration from a tiny script in `root.tsx` (register after
    load, ignore in unsupported browsers)
- **Subscription store:** `app/lib/push-registry.server.ts` — a
  JSON file (path from `VOIR_DATA_DIR`, default
  `dev-data/push-subscriptions.json` for local; a PVC mount in k8s).
  Holds `[{ endpoint, keys, p256dh, auth, folders: ["*"] | paths,
  createdAt }]`. voir has no DB; a file is consistent with the
  timeline store and is trivially backed up.

### API surface

As built, the client-facing push endpoints live under `/api/notify/*`
(the design's `/api/push/*` was taken by the git-push endpoint):

```
GET  /api/notify/config          → { publicKey } | { disabled: true }
POST /api/notify/subscribe       → 201 (from SW subscribe flow)
     body: subscription JSON from pushManager.subscribe()
POST /api/notify/unsubscribe     → 204 (unsubscribe cleanup)
POST /api/notify/test            → 204 (dev aid: fire a harmless push)
     body: { url?, text? } → notification links to that chat
```

UX: a bell toggle in the shared header (all views — push is
app-level, not per-session). Enable → `Notification.requestPermission()`
→ subscribe → POST. Icon state: on (amber) / off / denied (slashed).

### Delivery rules

- Push when **the agent settles** (mode 1) or **session adopted**
  (mode 3); body = first ~140 chars of the last agent message
  (mode 2: the passthrough text).
- **Suppress push when a viewer is watching:** if
  `sessionManager` has live SSE listeners for that session, the user
  is already watching — skip the push (the listeners set is the
  signal; a small helper exposes it).
- One push per turn-settle, keyed by `tag: folder+sessionId` so the
  OS groups rapid follow-ups instead of stacking.
- Errors `404`/`410` from the push service → delete subscription and
  continue (dead phones must not wedge the inbox request).

### Environment / device notes

- Web Push needs a **secure context**: `localhost` (dev on devbox)
  and `https://voir.lab` (Caddy on-demand TLS) both qualify.
- Android Chrome: push works for open sites; installing as a PWA is
  recommended for reliability. **iOS Safari: install is required**
  (16.4+). → add a minimal `public/manifest.webmanifest` + icons;
  also makes the phone experience sane regardless.
- Behind oauth2-proxy (ha.stackunderflow.no deployment): the push
  itself is server-side outbound (unaffected); the
  `notificationclick` URL opens the browser, which resumes the
  oauth2-proxy session normally. No special handling, but test it.
- Push payloads pass through browser push services — treat them as
  untrusted intermediaries: titles/bodies are short and
  non-sensitive; content is fetched by the already-authenticated tab
  after tap.

## Auth

Manual-curl phase: simple, but not open by default.

- `VOIR_INBOX_TOKEN` env; `/api/inbox*` requires
  `X-Voir-Token` matching. **As built:** if the token is unset the
  endpoint returns 503 rather than allowing loopback callers — a
  web `Request` doesn't reliably expose the peer address, so the
  doc's original "reject non-loopback" fallback wasn't honest.
- Push subscribe/unsubscribe/test stay same-origin (browser fetches
  with credentials; CSRF-safe via Origin check).
- Later: per-trigger tokens or an HA long-lived token style;
  PocketID client-credentials is overkill until a second machine
  needs in.

## Edge cases & interactions

- **Busy folder, busy session:** seeding targets a *new* session;
  `runPrompt` queueing is per-session, so no interference. Hand-off
  onto a session that is currently busy in voir → 409 (refuse
  rather than interleave).
- **Session not found on hand-off:** pi-acp `session/load` failure
  surfaces as a clear 404 body naming the folder/cwd expected.
- **Folder unregistered mid-flight:** existing "Folder unregistered"
  error message path already broadcasts; the inbox request itself
  already got its 201 — push on settle naturally fails silently
  after cleanup.
- **Timeline capture:** turn-end snapshots (`captureTimeline`)
  happen for seeded sessions too — free, unchanged.
- **Replay:** mode 2 divergence is the only state that doesn't
  survive `session/load`; see decision point above.

## Open questions

1. Mode 2 passthrough persistence: ephemeral origin cards vs
   re-inject after replay (lean: persist voir-side, small effort).
2. Does the first human reply quote the origin text to pi
   (self-contained turn) or do we queue the origin text as pi's
   first user turn at passthrough time? (lean: queue at passthrough
   time — pi sees the same timeline the user does, simplest mental
   model.)
3. Per-folder subscription prefs (subscribe to everything vs chosen
   folders) — default `*` for now?
4. `"latest": true` semantics for hand-off: watermark per folder
   (highest shown sessionId timestamp) vs "newest, period"?
5. Global SSE for in-app new-session badges: event shape
   (`session-created`, `session-adopted`, `folder-busy`) — needed
   before or after push? (push first; badges are Phase 2.)
6. Notification routing when multiple subscriptions exist: fan out
   to all with per-delivery cleanup (lean: yes).

## Phasing

1. **Phase 1 — exploration (manual curl): implemented.** See
   "Phase 1 — as built" below for deviations from this plan.
2. **Phase 2:** mode 2 (passthrough) + its persistence decision;
   mode 3 (hand-off) + `session/list` refresh; global SSE + unread
   badges in folder view.
3. **Phase 3:** real triggers — replace the home-ass/hiet cron
   one-way phone pushes with hand-off conversations; HA webhook
   automation; k8s deployment (VAPID secret, PVC for the
   subscription file, oauth2-proxy verification).

## Phase 1 — as built

Shipped in this repo (server: `app/lib/push.server.ts`,
`app/routes/api.notify.tsx`, `app/routes/api.inbox.tsx`; client:
`app/lib/use-push.ts`, bell in `app/components/chat/Header.tsx`,
handlers in `public/sw.js`). Verified server-side with curl
(config/subscribe/test, dead-subscription cleanup on push-service
404, inbox auth 401/400/404); real-device delivery still needs a
phone test. Deviations from the original design above:

- **Route names:** `/api/notify/*` instead of `/api/push/*`
  (`/api/push` is the git-push endpoint); unsubscribe is a POST
  with `{ endpoint }`, not a DELETE with a body.
- **Module layout:** one `app/lib/push.server.ts` (registry store
  + VAPID + fan-out) instead of a separate `push-registry.server.ts`.
- **Auth:** `VOIR_INBOX_TOKEN` unset → 503 (see Auth above).
- **Suppression:** implemented via `sessionManager.listenerCount()`;
  the inbox's settle watcher unsubscribes itself, then pushes only
  if no SSE viewers remain. Error turns also push ("Turn failed…").
- **Bell:** shown on every view (push is app-level), not chat-only.
- **`from` field:** the origin marker is applied by voir
  (`[from: <from>] <prompt>`) rather than trusting the caller to
  include it; `from` is optional and defaults to none.
- **Subscription store:** `VOIR_DATA_DIR` (default `dev-data/`),
  file `push-subscriptions.json`, gitignored; idempotent re-subscribe
  replaces by endpoint; 404/410 removes, transient errors keep.

## Manual-curl test recipes (Phase 1 acceptance)

Keys/token live in the repo root `.env` (gitignored) — vite loads
it; for the systemd/serve path export them yourself.

```sh
# 0) in the browser at https://chat.lab: bell toggle → bell turns amber

# 1) plumbing check
curl -X POST https://chat.lab/api/notify/test \
  -H 'Content-Type: application/json' -d '{}'   # → phone buzzes

# 2) agent-mediated conversation, phone closed
TOKEN=$(grep ^VOIR_INBOX_TOKEN .env | cut -d= -f2)
curl -X POST https://chat.lab/api/inbox \
  -H 'Content-Type: application/json' -H "X-Voir-Token: $TOKEN" \
  -d '{"folder":"/home/bjorn/code/infra","from":"curl","prompt":"Give me a one-line status of the home k3s cluster.","notify":"on-settle"}'
# → pi works; on settle the phone buzzes with pi's reply excerpt;
#   tap → conversation opens → reply → pi continues with context.

# 3) hand-off dry run (Phase 2)
pi -p "Draft a one-paragraph note about backup gaps."   # headless, same cwd
curl -X POST https://chat.lab/api/inbox/handoff -H "X-Voir-Token: $TOKEN" \
  -d '{"folder":"'$PWD'","latest":true}'
# → the headless session appears, replayed, with a push notification.
```

Success criteria: with voir closed on the phone, the machine can
start a conversation; the push lands and deep-links into it; the
reply continues the same ACP session id.