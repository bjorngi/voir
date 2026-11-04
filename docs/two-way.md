# Two-way conversations: machine-initiated chats + Web Push (design)

**Status:** Mode 1 **implemented** (see "Phase 1 — as built") and
**in daily production use** estate-side — the hiet checkup and the HA
weekly review seed their conversations through it (see "Mode 1 in
production"). Hand-off (Mode 3) was **dropped**: the production
pattern proved Mode-1 summarizer seeds cover every current trigger
(see the Mode 3 section). Mode 2 passthrough is **deferred** design
with decisions recorded (see its section); the k8s deployment item
resolved to **voir stays host-local** (see Deployment decision).
**Scope:** let an external process (curl today; cron/HA shell-outs
now in production) start a conversation that appears in Voir, and
notify the user via Web Push — so the user can open Voir and reply,
and the agent continues with full context. The reply half and the
machine-initiated half both work (Mode 1); the Web Push channel is
live, including the inline-reply notification action.

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
subscription preferences (field reserved in the store; built when the
volume asks), changes to pi-acp or the ACP protocol, and moving voir
off the host its agents run on (resolved as a decision — see
Deployment decision).

## Current state (verified in this repo — the 2026-10-22 pre-Phase-1 scan)

The scan the design was anchored on, kept for context. Superseded
where the "as built" sections say so — the notification-plumbing
bullet below predates `public/`, `sw.js` and `push.server.ts`.

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
must be mediated by voir. Two modes (a third — hand-off — was
designed here and later dropped; see its section):

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
  "notify": "on-settle",          // "on-create" | "on-settle" | "both" | "none"
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

**Status: deferred.** The estate's current machine traffic (hiet
checkup, HA weekly review) is all *analysis wanting an agent turn* —
Mode 1 covers it. HA's *event* traffic (dishwasher done, door, water
sensor) has no channel today, but nothing presses for it yet.
Decisions recorded from the 2026-11 discussion so the build needs no
re-litigating: events live in **`/home/bjorn/code/home-ass`** (the
home lane — the agent is already present there via the weekly-review
registration), organized as a **persistent "HA events" thread** —
see Threading below.

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

**Threading (decided):** one persistent **"HA events"** session
(find by title, else create) — event cards append there and pushes
group via `tag`, so twenty sensor events a week don't become twenty
one-turn sessions in the list. An event that wants to *stand out*
("door left open — handle it?") may still warrant a one-off session.
With a thread accumulating history, the reply-semantics lean flips
to **first-reply quoting**: the human's reply is a self-contained
turn quoting the event it answers — queueing every passthrough event
as an agent turn would ping-pong the agent on each sensor ping.

### Mode 3 — hand-off (pi created the session elsewhere)

**Dropped (2026-11 discussion).** The predicted triggers arrived
differently: the hiet checkup and HA weekly review seed *summarizer
conversations* (Mode 1) rather than adopting their headless sessions,
and the pattern proved out — the summary conversation carries the
report path in its context, the agent can re-read anything on
request, and it costs one small turn instead of replaying a whole
analysis into the transcript. Two facts would have kept hand-off
narrow anyway: `--no-session` runs (the weekly review) persist
nothing for voir to adopt, and the `"latest": true` watermark
semantics never found a solid answer (former open question 4). The
only shape hand-off still earns its keep is a **long-running
interactive headless job** — an unattended repair you want to watch
and steer mid-flight. If such a trigger shows up, build
`/api/inbox/handoff` then; this document's git history keeps the
full design.

### Why not have pi-acp push sessions at voir

The ACP direction is fixed (agent never initiates), and pi-acp
shouldn't grow voir-specific knowledge. voir owns the user-facing
model, so voir owns conversation instantiation. The inbox endpoints
are the seam.

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
                                `notificationclick` → inline reply /
                                    open the conversation URL
```

- **Library:** [`web-push`](https://www.npmjs.com/package/web-push)
  (de-facto standard; handles VAPID + per-subscription encryption).
  Payload ≤ 4 KB — `{ title, body, url, tag }`; when the
  notification should offer the inline-reply action it also carries
  `folder` + `sessionId` (as built in `push.server.ts`).
- **VAPID keys:** generated once
  (`npx web-push generate-vapid-keys`), stored as env
  `VOIR_VAPID_PUBLIC_KEY` / `VOIR_VAPID_PRIVATE_KEY`.
  If absent → the feature is off (routes return 503); no silent
  failure. Public key reaches the client via `GET /api/notify/config`
  for `pushManager.subscribe({ applicationServerKey })`.
- **Service worker:** `public/sw.js` (first file in voir's first
  `public/` dir; vite copies it to the build root, react-router-serve
  serves it statically). Handlers as built:
  - `push` → `showNotification` with `open` / inline-`reply`
    (`type: "text"`) actions when the payload carries
    `folder` + `sessionId` — Android Chrome renders the reply entry
    in the shade, desktop Chrome shows buttons, iOS ignores actions
  - `notificationclick` → `reply` POSTs
    `{ folder, kind: "send", text }` to
    `/api/sessions/:sessionId/action` (fire-and-forget, same contract
    as the composer) and confirms with a follow-up notification
    ("Reply sent" / "Reply failed"); a plain click focuses a window
    already on that conversation URL, else opens one
  - `pushsubscriptionchange` → re-subscribe + POST new subscription
  - registration from a tiny script in `root.tsx` (register after
    load, ignore in unsupported browsers)
- **Subscription store:** `app/lib/push.server.ts` (as built; the
  design's separate `push-registry.server.ts` was folded into it) —
  a JSON file (path from `VOIR_DATA_DIR`, default
  `dev-data/push-subscriptions.json`; in production the data dir is
  set in voir's `.env` and backups ride the devbox restic sets,
  DEVBOX.md). Holds `[{ endpoint, keys, p256dh, auth,
  folders: ["*"] | paths, createdAt }]`. voir has no DB; a file is
  consistent with the timeline store and is trivially backed up.

### API surface

As built, the client-facing push endpoints live under `/api/notify/*`
(the design's `/api/push/*` was taken by the git-push endpoint):

```
GET  /api/notify/config          → { publicKey } | { disabled: true }
POST /api/notify/subscribe       → 201 (from SW subscribe flow)
     body: subscription JSON from pushManager.subscribe()
POST /api/notify/unsubscribe     → 204 (unsubscribe cleanup)
POST /api/notify/test            → 204 (dev aid and the quiet-hours
     deferral lane): body { url?, text?, title?, tag? } — title/tag
     overrides make a deferred push render like the real one
```

UX: a bell toggle in the shared header (all views — push is
app-level, not per-session). Enable → `Notification.requestPermission()`
→ subscribe → POST. Icon state: on (amber) / off / denied (slashed).

### Delivery rules

- Push when **the agent settles** (mode 1); body = first ~140 chars
  of the last agent message (mode 2 — when built — the passthrough
  text).
- **`notify: "none"` never pushes** — the conversation is created
  and the agent turn runs, but the phone stays silent. Used by
  machine lanes that want the analysis ready for later reading
  (the alert-bridge warning lane) and by quiet-hours criticals,
  whose push is deferred by the bridge and fired after quiet hours
  via `/api/notify/test` (which accepts `title`/`tag` overrides so
  deferred pushes render like real ones).
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
  and `https://chat.devbox.stackunderflow.no` (the production host)
  both qualify.
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
- In production, every caller (cron/systemd units, HA shell-outs)
  shares `VOIR_INBOX_TOKEN` through `voir-inbox.sh`. Later if ever:
  per-trigger tokens to isolate consumer classes; PocketID
  client-credentials is overkill until a second machine needs in.

## Deployment decision: voir stays host-local (2026-11)

The phasing's k8s item resolved as a decision rather than work:

- Voir is host-coupled to its agents by design: `agentUrl`
  registrations are loopback (the launcher's stdio→HTTP bridge binds
  `127.0.0.1`), and the supervisor PATCH proxy (fence switching)
  talks to a same-host supervisor port. An in-cluster voir breaks
  both — every agent would need `--bind 0.0.0.0` plus a routable URL,
  and the bridge's "never leaves the machine" property evaporates.
- Cross-host agents are handled the right way already: the k8s `ha`
  namespace pod (pi-acp against Home Assistant) registers with the
  devbox voir via `--bind`/`--url`. Agents live where their
  worktrees and tools live; voir lives with the supervisor.
- What the k8s item worried about, the current deployment already
  answers: VAPID keys and `VOIR_DATA_DIR` ride voir's `.env`; the
  state dirs are restic'd (`~/.local/state/voir` — DEVBOX.md); prod
  runs as a systemd unit, not a pod.
- Remaining hardening (not a port): keep port 10001 off non-tailnet
  interfaces, and put real front-door auth (oauth2-proxy or similar)
  in front if the exposure ever changes.

## Edge cases & interactions

- **Busy folder, busy session:** seeding targets a *new* session;
  `runPrompt` queueing is per-session, so no interference.
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
   re-inject after replay (lean: persist voir-side — same
   `VOIR_DATA_DIR` pattern as the push registry and session status —
   so the persisted "HA events" thread stays honest across replays).
2. Reply semantics in the events thread: quote the event text into
   the human's reply (lean — self-contained turns; queueing every
   event as an agent turn would ping-pong the agent) vs queueing the
   passthrough text as pi's user turn at passthrough time.
3. Per-folder subscription prefs (subscribe to everything vs chosen
   folders) — default `*` now, field reserved in the store; build
   when the HA lane's event volume asks for it.
4. Global SSE for in-app new-session badges: event shape
   (`session-created`, `session-adopted`, `folder-busy`) — needed
   before or after push? (push first; badges are Phase 2.)

(Fan-out to all subscriptions: resolved by construction —
`sendPush` fans out with per-delivery cleanup of dead endpoints.
Hand-off watermarking: moot with Mode 3 dropped.)

## Phasing (rewritten 2026-11 — production ran ahead of the plan)

1. **Implemented, and already the estate's production channel:**
   Mode 1 (see "Mode 1 in production"). The planned Phase-3 "real
   triggers" work arrived as Mode-1 summarizer seeds — the hiet
   checkup and HA weekly review seed their conversations daily; the
   old one-way phone pushes are retired. No trigger wiring remains.
2. **Dropped:** Mode 3 hand-off (summarizer seeds cover the current
   triggers — see the Mode 3 section) and the k8s deployment (voir
   stays host-local — see Deployment decision).
3. **Deferred, design in place:** Mode 2 passthrough for the HA
   event lane; per-folder push prefs; push body = the question
   instead of the sentinel excerpt (contextual-tools.md leftover).
4. **Open (Phase-2 leftovers):** global SSE + in-app unread badges —
   push covers the closed app, badges would cover the open one.

## Phase 1 — as built

Shipped in this repo (server: `app/lib/push.server.ts`,
`app/routes/api.notify.tsx`, `app/routes/api.inbox.tsx`; client:
`app/lib/use-push.ts`, bell in `app/components/chat/Header.tsx`,
handlers in `public/sw.js`). Verified server-side with curl
(config/subscribe/test, dead-subscription cleanup on push-service
404, inbox auth 401/400/404); **in production estate-side since
2026-10-22** (see the next section). Deviations from the original
design above:

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

### Mode 1 in production (estate-side, 2026-10-22+)

The estate adopted the inbox ahead of this doc's phasing — this is
the Phase-3 "real triggers" work, landed as Mode-1 seeds:

- **`~/code/infra/hiet/scripts/voir-inbox.sh`** — thin wrapper:
  stdin prompt, `--folder/--title/--from/--notify/--agent`, token
  read from voir's `.env`, 3 × 10s retries (covers a voir restart
  plus agent re-registration), `--dry-run`. On a successful seed it
  calls `trace-link.py seed`, which fills the conversation's
  Tempo-trace root slot and — for registry timers — emits a marker
  span linking the timer trace → the conversation
  (OBSERVABILITY.md §8.6).
- **hiet checkup** (`ai-checkup.timer`, daily 08:30): health
  collectors → one-shot pi writes `reports/check-<date>-analysis.md`
  → seeds a "hiet checkup <verdict> <date>" conversation into
  `/home/bjorn/code/infra` summarizing it. A collection-stage failure
  seeds a *failure-diagnosis* prompt instead. The notification is
  best-effort — it never fails the checkup itself.
- **HA weekly review** (`weekly-review.timer`, Mon 08:00): runs
  `pi --print --no-session` → `suggestions/<date>.md`, then seeds a
  summarize conversation — or a "review FAILED, diagnose it" seed
  when the report is missing/empty. The old HA
  `notify.mobile_app_pixel_8` push is retired; voir + Web Push is
  the channel.
- **Quiet-hours deferral** (alert-bridge warning lane): seeds with
  `notify: "none"` and fires the push after quiet hours via
  `/api/notify/test` with `title`/`tag` overrides (see Delivery
  rules).
- **Inline reply:** the service worker's Reply action POSTs
  `{ folder, kind: "send", text }` to
  `/api/sessions/:sessionId/action` — supported as a
  fire-and-forget send (same contract as the composer), confirmed by
  a follow-up notification ("Reply sent" / "Reply failed").
- **Fan-out:** every registered subscription receives the payload,
  with per-delivery cleanup of dead endpoints (404/410) — resolved
  former open question 6 by construction.

## Manual-curl test recipes (Phase 1 acceptance)

Keys/token live in the repo root `.env` (gitignored) — vite loads
it; for the systemd/serve path export them yourself.

```sh
# 0) in the browser: bell toggle → bell turns amber

# 1) plumbing check — buzzes every subscribed device
curl -X POST https://chat.devbox.stackunderflow.no/api/notify/test \
  -H 'Content-Type: application/json' -d '{}'

# 2) agent-mediated conversation, phone closed
TOKEN=$(grep ^VOIR_INBOX_TOKEN .env | cut -d= -f2)
curl -X POST https://chat.devbox.stackunderflow.no/api/inbox \
  -H 'Content-Type: application/json' -H "X-Voir-Token: $TOKEN" \
  -d '{"folder":"/home/bjorn/code/infra","from":"curl","prompt":"Give me a one-line status of the home k3s cluster.","notify":"on-settle"}'
# → pi works; on settle the phone buzzes with pi's reply excerpt;
#   tap → conversation opens → reply → pi continues with context.

# 3) the production path — the same call wrapped with token lookup,
#    retries and trace linkage:
#    ~/code/infra/hiet/scripts/voir-inbox.sh
echo "Summarize the newest hiet report in three lines." \
  | voir-inbox.sh --folder /home/bjorn/code/infra \
      --title "manual smoke $(date +%F)" --from manual/curl
```

Success criteria: with voir closed on the phone, the machine can
start a conversation; the push lands and deep-links into it; the
reply continues the same ACP session id.