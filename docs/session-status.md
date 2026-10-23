# Session status: the active set & live state

**Status:** implemented (store, overlay, API and UI — see
`session-status.server.ts`, the `activityOf`/`activeSnapshot`
exports in `sessions.server.ts`, `api.session-status.tsx`, the
"Working on" sections and the header star). This doc also
**supersedes** the done/archived tri-state design that
previously lived in this file (git history has it) — the
polarity is inverted: instead of triaging the graveyard, you
curate the shortlist, and every view leads with it. Everything
is anchored in the code; check the anchors before changing.

**Scope:** marking sessions across *all* ACP agents (voir is
deliberately agent-agnostic), **plus** surfacing what voir
already knows about the live state of each session. Two
orthogonal layers, one word each answers a different question.

## The problem

Two problems; the old design only saw the first.

1. A folder accumulates sessions forever (`+ New chat` a few
   times a day, the list grows and never shrinks), and every
   session shows up in every list because `session/list` (see
   `AcpClient.listSessions` in `app/lib/acp-client.server.ts`)
   carries no flag and offers no mutation RPC —
   `SessionListEntry` is `{sessionId, title?, updatedAt?,
   cwd?}` and that's the whole truth. No `session/delete`, no
   `session/rename`, no `session/set_meta`. So any status must
   live **in voir**, as an overlay on agent truth — the same
   call the protocol forces on every ACP client.

2. Voir knows more than the lists show. `SessionState.busy`
   (a turn in flight), `SessionState.queueDepth` (mirrored from
   `session_info_update._meta.piAcp.queueDepth` in
   `handleQueueUpdate`), `FolderState.status: "ok" | "degraded"`
   — none of it is visible outside the one open chat.
   *"Which of my sessions are mid-turn right now, and which are
   waiting on me?"* has no answer today; you open each chat in
   turn to find out.

The old design answered #1 with opt-out triage (mark the
finished ones done/archived). It never touched #2. The
inversion below answers both.

## The decision: curate-in, and show the ball

```
membership — persistent, voir-owned       live state — derived, in-memory
  active   written; the shortlist            working   turn in flight (busy)
  (pile)   default; never written            waiting   turn done, ball with you
  archived written; the junk drawer          fresh     created, never prompted
                                          idle       stub: agent truth only
                                          offline    agent leg degraded
```

- **Membership** answers *"what are we working on"*. Persisted
  (`~/.local/state/voir/session-status.json`), keyed by folder
  path + session id, so it survives both voir restarts (the
  store is on disk) and agent restarts (session ids are UUIDs
  that survive launcher restarts — `findOrLoadSession` already
  relies on this).
- **Live state** answers *"where is the ball"*. Derived on the
  fly from `SessionManager`'s in-memory truth, never persisted,
  best-effort and honest about what it can't know.

Why invert:

- Triage-out asks the user to manage a growing graveyard
  forever. Curate-in asks only "keep a shortlist" — and the
  pile stops mattering, because every entry surface (root
  view, picker) leads with the shortlist.
- **Auto-activation** (below) makes the shortlist maintain
  itself: anything you create or prompt becomes active. The
  only manual act is cleaning up — unstar when done — the
  mirror image of the old design, where the only manual act
  was burying. Stale one-off questions cost one ✕ tap, and the
  sort sinks them anyway.
- The dashboard turns voir's in-memory truth into a product
  feature instead of chat-internal state. Machine-seeded inbox
  conversations (`api.inbox.tsx` creates then prompts) surface
  in the shortlist as *working* — you can see the machine is
  running something without opening the chat.

## Data model: membership store

File: `$VOIR_DATA_DIR/session-status.json` (default `dev-data/`)
 — the same "durable state on the filesystem" convention as
`push.server.ts`'s subscription registry, so deployments mount
one data dir and get everything. (The supervisor's
`~/.local/state/voir/agents.json` is a different process's
convention; the app's own precedent wins here.)

```json
{
  "version": 1,
  "folders": {
    "/home/you/worktrees/feat-42": {
      "019ea1f1-217d-7eaa-87d4-d930e92259ab": {
        "status": "active",
        "at": 1760000000000
      }
    }
  }
}
```

- **Key:** folder path (normalized the same way as
  `normalizeFolder`) + sessionId. Not agent name — session ids
  are UUIDs unique across the agents under a path, and a
  worktree re-registering under a new agentUrl (launcher
  restart, new port) still matches. A path that later hosts a
  different agent engine inherits only the statuses for session
  ids it actually knows — harmless.
- **`status`:** `"active"` or `"archived"`. Absence = the pile
  (never written — the slot the old design called "active").
  `"archived"` is kept as the second word so a hide-tier never
  has to be un-migrated in later; it is not `done`.
- **`at`:** epoch ms of the last transition into the current
  status. For debugging; UI sorting uses live state, not this.
- **Writes:** atomic (tmp file + rename). Debounced flush
  (~500ms trailing) — auto-activation means a write per prompt,
  still rare compared to messages. Concurrent voir instances are
  out of scope (the supervisor already assumes one daemon per
  machine).

New module `app/lib/session-status.server.ts`, a small
server-singleton mirroring `timeline.server.ts`'s pattern (and
`sessionManager`'s `globalThis.__radharc_sessions` HMR-cache
trick — a fresh module instance per HMR reload would orphan
the flush timer):

```ts
getStatus(folder, sessionId): "active" | "archived" | undefined
setStatus(folder, sessionId, status: "active" | "archived" | "none"): void
// "none" removes the entry → back to the pile. Persists (debounced).
listActive(): Array<{ folder, sessionId, at }>   // feeds the snapshot
prune(folder, knownIds: Set<string>): void       // called by SessionManager
```

### Auto-activation

Per the product decision: **voir writes `active` on every
deliberate act of working.**

- `SessionManager.createSession` — every new chat is active by
  definition (this covers machine-seeded inbox conversations:
  `api.inbox.tsx` creates then prompts).
- `SessionManager.sendMessage` — prompting *is* working on it.
  Prompting a pile session pulls it into the shortlist;
  prompting an archived session is a deliberate dig-out and
  re-activates it (un-archives). There is no "prompt once
  without tracking" path, and none is needed.

Un-starring is the only manual cleanup act.

### Pruning

The store outlives sessions; orphans must not leak UI rows
(they can't — the snapshot resolves entries against
`SessionManager`'s memory) and should eventually die:

  Prune a folder's entries only during `SessionManager.
  listSessions` — only when that folder's agents **just
  answered** `session/list` (never while `status ===
  "degraded"` or unregistered, where "session/list didn't
  mention it" means nothing), and only when the iterated
  agents are *all* the agents under the path (a named call on
  a multi-agent path sees a partial union — the code guards
  with `agents.length === agentsUnder(folder).length`). Drop
  ids absent from the fresh list. A stale entry costs a few
  hundred bytes — err on the side of keeping.
- **Do NOT prune on `DELETE /api/folders`.** The old design left
  this open ("probably yes"); the answer is no:
  `bin/acp-spawn.mjs` calls `registrar?.unregister()` on every
  teardown (its header comment: "→ unregister → kill child →
  exit 0"), so DELETE is routine launcher lifecycle, not a
  deliberate human act. Statuses must survive launcher
  restarts; the listSessions prune handles truly-dead
  sessions once the folder is registered and answering again.

## Live state: derivation

Pure helper, exported from `sessions.server.ts` (unit-testable
with plain objects):

```ts
type ActivityState = "working" | "waiting" | "fresh" | "idle" | "offline";

function activityOf(state: FolderState, session: SessionState): {
  state: ActivityState;
  queued: number;          // session.queueDepth ?? 0
  lastActivityAt: number;  // last message `at`, else createdAt
}
```

Evaluated in priority order:

| condition | state | note |
|---|---|---|
| `state.status === "degraded"` | `offline` | overrides everything — busy isn't trustworthy on a dead leg |
| `session.stub === true` | `idle` | voir knows only agent truth (title, updatedAt); makes no live claim |
| `session.busy` | `working` | `inFlightPrompts > 0`; render a "queued n" badge when `queueDepth > 0` |
| held, `messages.length > 0` | `waiting` | turn done, the agent waits for you |
| held, no messages | `fresh` | created, never prompted |

**Stub marker.** `listSessions` hydrates sessions it doesn't
hold as empty stubs (`state.sessions.set(entry.sessionId,
{…, messages: [], busy: false})`). Without a marker those are
indistinguishable from genuinely-empty chats and would read as
`fresh`. Add `stub?: boolean` to `SessionState`: set it at the
stub-creation site in `listSessions`; clear it in `loadSession`
(which *reuses* the stub object — the `existing ?? …` path)
and, by symmetry, `resumeSession`; `createSession` never sets
it. Everything resolved through `findOrLoadSession` clears it.

**Honesty limits** (document, don't hide):

- After a voir restart, every session is a stub → everything
  reads `idle` until opened. Whether a turn that ran across the
  restart is still in flight is **unknowable** — ACP has no
  "is this session mid-turn?" RPC. `idle` is the honest answer;
  it upgrades the moment the session is loaded or prompted.
- `waiting` is technically true forever once a turn ends.
  Staleness is carried by `lastActivityAt` ("waiting · 3h
  ago"), not by dropping the pill.

## Semantics

- **active** — member of the **"Working on"** shortlist: the
  live section at the top of the root view and pinned at the
  top of the picker; filled star in the chat header; a dot
  marker next to the title in the pile lists.
- **pile (unmarked)** — listed as today, everywhere,
  recency-sorted. Nothing hidden, nothing to manage. The honest
  default for every fresh install and every session you never
  touch again.
- **archived** — the junk drawer. Hidden from every list by
  default (root tree, sessions view, picker). The sessions view
  gets a per-view ephemeral "Show archived" toggle (component
  state, default off — hidden must be the honest default on
  every visit) revealing rows with a badge and lighter style.
  Direct URLs still load: `findOrLoadSession` is untouched;
  status never gates loading, only listing. The chat header
  shows a small "archived" pill so a loaded-by-URL archive
  doesn't look identical to a pile session.
- Transitions: any is legal; `active` and `archived` are
  exclusive by construction (setting either clears the other).
- The agent's own session list (`pi --resume` etc.) is
  unaffected — voir's label is voir-local (no ACP channel, see
  non-goals).

## Integration points

1. **Store module** `app/lib/session-status.server.ts` (above).
   One-way imports: `sessions.server.ts` → store. The store
   must not import the session manager.

2. **Auto-activation** in `sessions.server.ts`:
   `createSession` calls `store.set(state.path, id, "active")`
   after `state.sessions.set(...)`; `sendMessage` right after
   the `state`/`session` resolution.

3. **Overlay.** Extend `SessionSummary` (`app/lib/chat-types.ts`)
   with `status?: "active" | "archived"` (`undefined` = pile)
   and stamp it in **`folderSummary`** — the single projection
   point every loader branch uses (`chat.tsx` maps all folder
   states through it). Note `sessionSummary` alone has no
   folder in scope; stamp in `folderSummary`'s map, not there.
   The `k: "chat"` loader branch also carries the session's
   `status` (read the store where `p.folder`/`session.id` are
   in scope) for the header star.

4. **Snapshot.** `activeSnapshot()` exported from
   `sessions.server.ts`: iterate `store.listActive()`, resolve
   each (folder, sessionId) in memory via a new public
   `lookupSession(folder, sessionId)` — a thin wrapper over the
   private `sessionAgent` + `sessions.get`; in-memory only, no
   agent round-trip, no loading — derive `activityOf`, sort
   (working → waiting → fresh → idle → offline, then
   `lastActivityAt` desc), and shape the wire rows:

   ```json
   { "folder": "/home/you/worktrees/feat-42", "agentName": "pi",
     "sessionId": "…", "title": "Fix the login bug",
     "state": "working", "queued": 2, "lastActivityAt": 1760000000000 }
   ```

   Entries that can't resolve (folder unregistered) are
   given one bounded hydration chance first — `listSessions`
   on that folder, at most once per 15s per folder — because
   a store entry can outlive voir's memory (restart) or be
   created by another actor (the inbox seeds a conversation
   while a dashboard is open). Whatever still doesn't
   resolve is skipped: there is nothing honest to say about
   it, and the store keeps the entry until pruned (see
   above).

5. **API** — `app/routes/api.session-status.tsx`, registered in
   `app/routes.ts` (`route("api/session-status", …)`). Kept
   separate from `api.session-action.tsx` on purpose: that
   route proxies RPCs *to the agent*; status is voir-local
   state, and conflating the two invites the assumption that
   it round-trips through the agent.

   - `GET /api/session-status` → `{ sessions: […] }` — a thin
     wrapper over `activeSnapshot()`. This is the poll target.
   - `POST /api/session-status` with
     `{ folder, sessionId, status: "active" | "archived" | "none" }`
     → `{ ok: true }`. Validation: session resolvable via
     `lookupSession` (404 otherwise — one check covers unknown
     folder and unknown session), status one of the three
     words. Writes the store. (The held `SessionState` needs no
     patching: `folderSummary` and the snapshot read the store
     directly at projection time, so the next render — or the
     poll — sees the new truth; toggling UIs update
     optimistically.)

6. **UI.**

   - **Root view = the dashboard.** The `k: "folders"` loader
     branch returns `active: activeSnapshot()` — a
     server-rendered seed, honest first paint. `ChatApp` lifts
     the polled state and `FoldersView` renders "Working on"
     at the top: rows of state dot + word, title,
     `shortPath(folder)` badge, `timeAgo(lastActivityAt)`,
     "queued n" when > 0. Tap → the chat (fast switch); ✕ →
     unstar (optimistic POST). Below: the existing folders
     tree, unchanged except archived rows hidden and active
     rows marked with the dot. Empty state: "Nothing active —
     star a chat or start a new one."
   - **Picker** — a "Working on" section pinned above
     "Folders", same rows from the same polled state; tap →
     navigate + close. This is the fast-switch surface: the
     menu button is on every view, so *anywhere → menu →
     session* is two taps. Archived never appears here
     (searching your archive is a rare need; keep the picker
     simple — the old design's call, kept).
   - **Chat header star** — `Header.tsx` grows a star prop
     (chat view only): filled when active, dim otherwise,
     optimistic toggle via POST. On an archived session it
     renders the "archived" pill and acts as "make active".
   - **Sessions view** — active rows get the dot; an
     archive/unarchive row action per row (small
     absolute-positioned button, the `SessionDebugButton`
     pattern already used on those rows); the "Show archived"
     toggle.
   - Row actions are plain buttons (mobile-first, one tap), no
     long-press menus in v1.

7. **Polling.** `useSessionStatus()` in `app/lib/hooks.ts`
   (next to `usePageVisible`, which it composes): fetch
   `GET /api/session-status` every 2s while the document is
   visible, immediate refetch on becoming visible, nothing
   while hidden; seeded from loader data until the first fetch
   lands. Why poll, not a global SSE: per-session SSE exists
   (`api.stream.tsx`) but a global activity stream needs a new
   SessionManager broadcast surface plus reconnect machinery,
   and the dashboard needs ~2s freshness at most (turns last
   minutes) for a payload of a few hundred bytes. The upgrade
   path (a global `/api/activity` SSE) stays open if polling
   ever chafes.

8. **Helper** — `timeAgo(ms)` in `app/lib/format.ts` (none
   exists today; it has only `shortPath`). "now", "3m", "2h",
   "4d" style, capped at days.

## Non-goals / out of scope (for now)

- **Pushing status to agents** — no ACP RPC exists. If the spec
  grows session metadata, the store becomes a write-through
  cache and the overlay stays.
- **Auto-un-activation heuristics** — e.g. "drop from the
  shortlist after N idle days". The sort handles staleness;
  heuristics can be layered later without migration (the store
  is just rows).
- **Waiting-for-permission state** — ACP
  `session/request_permission` isn't handled by voir today
  (pi-acp runs its own approval flow). If it ever is, it slots
  into `activityOf` as another word.
- **Deleting sessions from voir** — no portable ACP delete;
  archive is the substitute. If a delete RPC appears, it slots
  into the same row action.
- **A global SSE activity channel** — poll first (see
  integration point 7).

## Testing

Node's built-in runner (`npm test`, `test/**/*.test.ts`), same
style as the existing suite:

- **store:** get/set round-trip; `none` removes; absence →
  undefined (pile); atomic flush; auto-activation writes;
  prune keeps known ids and drops unknown ones; prune never
  runs on degraded folders; **teardown DELETE must not prune**
  (the acp-spawn contract — a re-registered folder inherits its
  statuses).
- **overlay:** `folderSummary` stamps active/archived;
  undefined with no store file present (fresh install changes
  nothing); the chat loader carries `status`.
- **auto-activation:** via the mock-agent bridge harness
  (`bin/acp-spawn.mjs --no-register` + `bin/mock-acp.mjs`, as
  in `multi-agent.test.ts`): `createSession` marks active;
  `sendMessage` re-activates an archived session.
- **`activityOf`:** the pure matrix — offline/working/waiting/
  fresh/idle, `queued` badge, `lastActivityAt`; `stub` set by
  `listSessions`, cleared by `loadSession`.
- **API:** GET shape and sorting; POST rejects bad status words
  and unresolvable sessions, accepts the active/archived/none
  transitions.

## Build order (all steps shipped)

1. ✅ `session-status.server.ts` + `test/session-status.test.ts`.
2. ✅ `stub` marker + auto-activation + `activityOf` +
   `lookupSession` + the `folderSummary` overlay.
3. ✅ `api.session-status.tsx` (GET snapshot + POST transitions)
   + the `routes.ts` entry + `test/active-sessions.test.ts`
   (the end-to-end wiring on the mock bridge).
4. ✅ UI: `timeAgo` + `useSessionStatus` + "Working on" on the
   root view + the picker section.
5. ✅ UI: chat header star + archived pill; sessions view
   archive action + "Show archived" toggle.