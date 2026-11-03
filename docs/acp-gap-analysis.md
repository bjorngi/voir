# ACP gap analysis: the spec vs. what Voir uses

**Status:** research (Nov 2026) + the long-turn fix and
transcript-evidence busy inference **implemented** (see "As
built" below). The feature audit's other items are ranked
follow-ups, not built. Anchors point at the code; check them
before changing anything in this file.

**Scope:** what the current ACP spec (v1 stable + unstable,
[agentclientprotocol.com](https://agentclientprotocol.com))
offers that Voir is not using, and the concrete bug behind
"the agent is clearly working but Voir shows no loading bar
and no Stop button". Everything was verified against the
current docs/changelog *and* against the installed pi-acp
(`~/.npm-global/lib/node_modules/pi-acp`), since pi-acp is the
agent Voir actually runs.

## The long-turn bug, as found

**Symptom:** mid-turn, the loading bar and Stop button vanish
while chunks keep streaming — "agent working, Voir idle".

**Root cause: three layers, each sufficient on its own.**

1. **The bridge's 30s request race** (`bin/acp-lib.mjs`).
   Every JSON-RPC POST was raced against a hardcoded
   30-second timeout, 504ing on expiry. But per ACP,
   `session/prompt` resolves only when the *whole turn*
   settles — easily minutes. Reproduced with a 40s-turn
   stub agent through the real bridge: `HTTP 504 after
   30.0s` while chunks streamed on. Consequences: Voir's
   `runPrompt` error path broadcast `busy:false` (spinner
   gone, Stop gone), the agent never noticed (chunks kept
   flowing — transcript alive, state dead), the real
   `session/prompt` response was dropped on the floor
   (pending already answered), and the timeline snapshot
   ran at the 30s mark instead of turn end.

2. **fetch() on the client leg** (`app/lib/acp-client.server.ts`).
   Even with the bridge fixed, undici (Node's global fetch)
   enforces a ~300s `headersTimeout`: a silent ceiling that
   would break turns longer than five minutes exactly the
   same way. There is no way to extend it around `fetch()`.

3. **Busy is Voir-owned, not agent-known.**
   `SessionState.busy` is set by `sendMessage`/cleared by
   `runPrompt` — two paths whose owner disappears on a Voir
   restart (in-memory counter gone while the agent keeps
   streaming) or when the prompt POST fails. ACP v1 defines
   no agent→client "turn running" flag, so there was nothing
   to re-derive it from.

## As built (the long-turn fix)

**1. Bridge: no timeout race; liveness is child-driven**
(`bin/acp-lib.mjs`, `launchAgent`).

- The request path holds the POST open until the agent's
  response arrives on stdout. No `setTimeout` race exists
  anymore — deliberately; a per-request timeout with a big
  cap would just move the same cliff.
- On `child.exit` (and on `stop()`), `failPending()` settles
  every held request with an honest **HTTP 502**
  (JSON-RPC error body), so dead agents fail fast instead of
  hanging or lying. This is the proper replacement for what
  the 30s race was protecting.
- A client that gives up first just drops out of `pending`
  (`res` close handler); its late agent reply is discarded
  by the framing loop.
- `child.stdin.on("error")` swallows EPIPE so writes to a
  just-died child can't crash the bridge.

**2. Client leg: node:http with method-aware timeouts**
(`app/lib/acp-client.server.ts`, `postJson` +
`requestTimeoutMs`).

- `HttpJsonRpcTransport.send` now speaks plain
  `node:http`/`node:https` (no implicit ceiling) instead of
  `fetch()`.
- Timeout policy: `session/prompt` and `session/load` are
  **exempt** (0 = wait for the bridge; the bridge answers 502
  if the agent dies). Everything else keeps a 30s budget so a
  wedged agent fails fast — overridable for tests with
  `ACP_REQUEST_TIMEOUT_MS`.
- `ping()` (heartbeat) keeps fetch + AbortController — it's
  intentionally short-lived.

**3. Busy inference: claim busy from transcript evidence**
(`app/lib/sessions.server.ts`, `maybeClaimInferredBusy` /
`clearInferredBusy`, `SessionState.inferredBusy`).

ACP v1 has no "is a turn running?" signal, but the inverse is
provable from the wire:

- **Claim:** any live (non-replay) agent activity —
  message/thought chunks, tool_call, tool_call_update, plan —
  arriving with `busy == false` and no replay in progress
  proves the agent is mid-turn → set busy, mark it inferred,
  broadcast `busy:true`. Two gates guard against false
  positives:
  - **A turn requires a user turn.** Out-of-turn informational
    chunks — pi-acp pushes its startup banner (pi version /
    skills list) as a live `agent_message_chunk` right after
    `session/new` — arrive on sessions nobody has prompted;
    claiming there would stick every fresh chat in busy
    forever (no `running: false` ever follows an informational
    chunk). The gate is the transcript containing at least one
    user message, which every genuine recovery has (the
    replayed transcript holds the prompt that started the
    interrupted turn). Found live: the fresh-chat busy bar
    shipped for ~an hour before this gate.
  - **Replay is not activity.** Claims are suppressed while
    `session/load` replays (the `replaying` flag).
  This covers the Voir-restart rehydration (live chunks resume
  after the replay boundary) and the prompt-leg-failure case.
- **Release:** pi-acp publishes
  `session_info_update._meta.piAcp.running: false` on
  `agent_end` (queue drained) — the authoritative idle signal,
  already the source for `queueDepth`. Inferred busy releases
  on it. A claim never touches busy owned by a real
  `runPrompt` (the owner clears it; a `running:false` can
  precede the prompt RPC response by a hair).
- **Stale evidence:** a replay replaces the transcript from
  agent truth, so `resyncFolder` and the `loadSession` success
  path clear inferred busy after the replay boundary. If the
  agent genuinely is still mid-turn, live chunks re-claim it
  moments later (brief flicker, correct state).
- **Known limitation:** agent-agnostic inference has no turn-end
  signal for non-pi agents (they don't publish
  `running: false`). Their busy claim releases on the next Voir
  turn cycle or resync. Acceptable: pi-acp is the primary agent,
  and acp-spawn'd opencode/codex turns usually coincide with a
  Voir-owned prompt.

**Tests** (`test/bridge-requests.test.ts`,
`test/transport-timeouts.test.ts`, `test/busy-inference.test.ts`,
fixtures in `test/fixtures/`, helper in `test/helpers/bridge.ts`):
held 1.5s turn → 200 with real `stopReason` (and SSE chunks
streaming meanwhile); crashed agent → held requests settle 502
immediately; prompt/load exempt from an overridden 300ms budget
while `session/set_mode` honors it; busy claimed by an injected
out-of-turn chunk without any prompt, released by
`running: false`, not re-broadcast while held, not claimed by
title-only `session_info_update`, failed load attempts, or
pi-acp's startup banner on an unprompted session (the
fresh-chat regression), and not claimed during replay. The
40s stub-agent repro that failed before now returns
`HTTP 200 after 40.0s` with `end_turn`.

## ACP feature audit — what Voir doesn't use yet

Verified against the current stable v1 spec and pi-acp's
`initialize` result (`agentCapabilities` below is pi-acp, today:
`loadSession: true`, `promptCapabilities {image: true, audio:
false, embeddedContext: env}` , `sessionCapabilities {list:
{}}`).

### Correctness gaps (fix before anything else)

1. **Agent→client requests are never answered.**
   `session/request_permission`, `fs/read_text_file`,
   `fs/write_text_file`, `elicitation/create`, `terminal/*` are
   *requests* (they carry an `id` and block the agent until the
   client responds). Voir's dispatcher
   (`sessions.server.ts attachClientNotifications` /
   `handleSessionUpdate`) treats every incoming frame as a
   notification and never replies. The bridge forwards them
   over SSE and waits forever. pi-acp never sends any (which is
   why Voir gets away with it), but `claude-agent-acp` and
   `codex-acp` send `session/request_permission` routinely —
   attaching them today wedges turns.
   Minimum fix: a client-side request handler that auto-answers
   (configurable default, e.g. deny-and-say-so in chat).
   Proper fix: a permission card, the same pattern as the
   `ask_user` question card
   (docs/contextual-tools.md) — one shared UI seam for all
   three request types.
2. **`elicitation/create` is stable now** (0.13.x-era,
   stabilized ~1.7). docs/contextual-tools.md parked voir's
   elicitation support as "blocked on upstream pi-acp"; the
   protocol blocker is gone. When pi-acp bridges its dialogs,
   the same question card should answer both.

### Adopted — cheap, immediate wins

| Feature | State | Voir opportunity |
| --- | --- | --- |
| `usage_update` (stable) | stable: `used`/`size` tokens, optional `{amount,currency}` cost; Voir drops it (unhandled kind) | token/context badge in the header + Working-on rows; fleet cost becomes visible. No pi-acp support yet — handle the kind, don't depend on it |
| `promptCapabilities.image` | pi-acp **already advertises `image: true`** | the composer can attach images today (paperclip/camera on mobile, paste on desktop); `session/prompt` takes image content blocks — no protocol work |
| `notice` (stable, capability-gated) | requires `clientCapabilities.session.notices: {}` | advertise + render as toast/banner; agents currently degrade to plain agent messages |
| `compaction_update` + `compaction_summary_chunk` (stable, capability-gated) | requires `clientCapabilities.session.compaction: {}` | advertise + render as a transcript divider with the retained summary; beats the current "Automatic compaction finished" text hack (pi-acp's fallback) |
| `config_option_update` (stable) | typed agent settings (booleans/selects) | could join model/mode in the drawer when agents use it |
| `messageId` on chunks (stable, optional) | chunks with the same id = one message | exact message segmentation for agents that emit it; Voir currently infers boundaries |
| `session/delete` (stable, capability-gated) | gated on `agentCapabilities.sessionCapabilities.delete` | wire a trash action for agents that support it (none of ours do today) |
| `session_info_update` (stable) | title/updatedAt pushes — already handled (`handleInfoUpdate`) | also read `updatedAt` for list sorting instead of client-side `at` |
| notices/compaction `clientCapabilities` | opt-in | advertise what we can render; omit what we can't (current behavior is correct-but-lazy) |

### Longer-term / watchlist

- **v2 (unstable)** is a substantially different surface:
  foreground work (an actual "what is the agent doing" concept —
  the protocol-level answer to the busy-inference problem),
  message IDs required, unified session lifecycle
  (`session/open`), MCP-over-ACP request-scoped, subagents
  (RFD). Not for voir now; revisit when agents ship v2.
- **`session/resume` / `session/close`**: `resumeSession` exists
  in both `AcpClient` and `sessionManager` with **zero callers**
  — either wire it (a "resume elsewhere-loaded session"
  action) or delete it. `session/close` could free agent
  resources on folder removal.
- **`session/fork`** (unstable): could power "retry this branch
  of the conversation" later; needs agent support first.
- **`session/list` pagination**: already handled
  (`listSessions` follows `nextCursor`) ✓ nothing to do.
- **docs/session-status.md** was corrected: its "no
  `session/delete`" claim predated the stabilization; the
  overlay design stands (pi-acp supports neither delete nor
  rename).

## Suggested order of work (after this fix)

1. **Answer agent→client requests** (auto-answer + log, then the
   permission card) — unlocks non-pi agents.
2. **Image attach** — pi-acp is ready; pure client work.
3. **`usage_update` rendering** — future-proof fleet visibility.
4. **Notices + compaction** advertisement and rendering —
   better UX for context churn.
5. Decide `resumeSession`'s fate.

## Verification story for this file

- Long-turn behavior: `npm test` (bridge/transport/busy suites)
  plus the 40s repro above.
- Audit facts: agentclientprotocol.com docs (changelog 1.12.0 /
  2026-10-16 at research time), pi-acp source under
  `~/.npm-global/lib/node_modules/pi-acp/dist`. Re-check both
  before acting on any row of the table above.