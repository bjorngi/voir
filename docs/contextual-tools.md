# Contextual tools: terminal vs ACP/voir (design)

**Status:** design + **Phases 1–2 built** — the merged
`ask_user` extension (three runtime modes) and the voir
question card are installed and verified end to end (see
"Phase 1/2 — as built"). Everything else remains design;
everything below was verified against the current code unless
noted.
**Scope:** how tools should behave differently when the same
agent runs in a terminal (pi TUI) vs attached to voir through
ACP (pi-acp). Anchored on two concrete examples:

- `ask_user` — works in the terminal, **hangs forever under
  voir today** (pi-acp drops pi's `extension_ui_request`
  dialogs; the tool waits forever).
- "ask voir question" — a tool that only makes sense under
  voir (mobile question card + push), and must not exist in a
  terminal session.

**Headline:** the answer to both is **one own extension**,
already half-built: a single merged `ask_user` that branches on
pi's runtime mode — TUI dialogs in a terminal, a
**non-blocking "sentinel + follow-up answer"** flow under ACP.
The host (voir) renders a card from the standard `tool_call`
notification and posts the user's answers as a regular
`session/prompt`. Zero protocol work, zero transport work, no
hanging turns, and no per-context configuration needed for this
tool at all.

## What already exists on this machine

1. `~/.pi/agent/extensions/ask-user/` — **the merged
   `ask_user`** (see "Phase 1 — as built"): one tool, sentinel-
   first runtime modes — TUI widget card, RPC sentinel, print
   pending-file. Replaces the community extension of the same
   name (wire-compatible, same schema).
2. ~~`~/.pi/agent/extensions-voir/pi-ask-question-acp/`~~ —
   bjorn's parked `voir_ask_user` (June 2025, never loaded):
   the source of the sentinel design now merged into
   `ask_user`. **Deleted** once its wire contract moved into
   the merged extension's README.

The (since deleted) `extensions-voir/` parked dir was also
evidence of a dead
end: **one `settings.json` cannot vary per context.** A separate
extension *set* for voir requires a full alternate agent dir
(`PI_CODING_AGENT_DIR`) — workable (see "Remaining layers"), but
the merged-extension approach makes it unnecessary for ask_user.

## The recommendation: one merged `ask_user`

One extension, one tool name, sentinel-first in every runtime mode:

| `ctx.mode` | Behavior | Answers |
| --- | --- | --- |
| `tui` (terminal) | **sentinel + widget card** above the composer (`ctx.ui.setWidget`), non-blocking | follow-up user message (prompt-guided) |
| `tui` + `ASK_USER_DIALOGS=1` | opt-in modal dialogs (old community behavior) | structured tool result |
| `rpc` (pi-acp → voir, Zed, …) | **sentinel**: return immediately; host renders from `tool_call` | follow-up user message (prompt-guided) |
| `print`/`json` (headless) | existing `pending-questions.json` flow | next invocation |

- **Merge**: community ask-user's dialog/print logic +
  pi-ask-question-acp's sentinel logic, in one extension
  registered as `ask_user`, replacing the community one.
- **Why one tool name:** if `ask_user` and `voir_ask_user` are
  both registered, the model sees two same-shape tools and
  must pick per context — which it can't reliably do (both are
  registered in both contexts; a terminal call to the sentinel
  variant strands the user). One name, one habit, skills and
  muscle memory transfer. The `voir_` prefix existed only to
  coexist with the community extension — unnecessary once we
  own the merged one.
- **Why sentinel in TUI too** (not just RPC): a uniform
  transcript shape across runtimes makes questions
  **cross-runtime** — asked in a terminal, answerable after
  resuming the session in voir (or anywhere else), because the
  answer is just the next user message. Verified the dialog
  alternative is worse: an interrupted TUI dialog leaves a
  dangling tool call in the session (assistant `tool_use`
  with no `tool_result`), which projects straight into the
  model context — a shape many providers reject. The widget
  card renders the questions without blocking; it clears on
  `agent_start` (fires once per composer submit — not
  `turn_start`, which fires per model invocation and would
  wipe the card mid-turn; not `ui_prompt_start`, which only
  wraps blocking dialogs). Arrow-key modals remain available
  via `ASK_USER_DIALOGS=1`.
- **Why sentinel beats blocking** (the alternatives — HTTP
  long-poll to voir, ACP elicitation bridging — both block the
  tool until the human answers):
  - A phone user may not answer for hours. A blocking design
    holds the turn "busy" the whole time and needs: push-on-
    question, abort wiring (`ctx.signal` → fetch), orphan
    cleanup on folder unregister, restart persistence for
    pending questions. The sentinel design has *none* of these
    failure modes — the turn simply ends; answering whenever
    is a normal next message.
  - It rides transports that already exist: questions travel
    in the standard `tool_call` notification, answers in the
    standard `session/prompt`. No bridge changes (the bridge's
    missing agent→client response channel — see below — is
    never exercised).
  - Graceful in any host: a host that doesn't know the
    convention just shows the sentinel text; the user can
    still type an answer in chat. Degradation is textual, not
    a hang.
- **Cost, honestly:** the model is *prompt-guided*, not
  protocol-guaranteed, to treat the follow-up as answers. The
  existing extension already ships the mitigations:
  `promptGuidelines` anti-loop bullets ("do not call it again;
  the next user message is your answers"). voir further
  mitigates by formatting the answer message explicitly
  ("Q1: … A1: PostgreSQL (Recommended)"). That same
  Q/A-text-as-user-message shape is also exactly what the TUI
  tool result reads like, so context stays consistent across
  runtimes.

## voir host side (the only new code in voir)

1. **Surface `rawInput`** — pi-acp already emits `rawInput`
   (the tool call args, i.e. the questions) on `tool_call`,
   but voir's `handleSessionUpdate` drops it (verified: no
   `rawInput` in `chat-types.ts`/`sessions.server.ts`). Add it
   to the `tool` ChatMessage and stream.
2. **Question card** — render an `ask_user` tool call
   (`name`/`rawInput.questions`) as a card with tappable
   options (labels + descriptions, "Other…" free-text). Tapping
   an option fills the composer with a formatted answer; send
   is the normal send. Keep the composer usable for free text
   (interrupting a question is legitimate — the prompt
   guidelines handle it).
3. **Push** — the two-way.md on-settle push already fires when
   the turn ends; for a turn whose last tool was `ask_user`,
   the body should be the first question ("the agent asked:
   which database?"). No new push plumbing.
4. **Voice** (later) — the card is what voice mode can read
   out; answering by voice becomes "tap to edit transcript"
   + send, already the voice-mode pattern.
5. **Replay** — free: the tool call (questions) and the user
   answer message are both in the transcript and both survive
   `session/load`. The card renders from the tool call either
   live or replayed.

## Current state (verified), minus what the sentinel avoids

- **The hang (gap 1)** — solved by the merged extension's RPC
  branch. (Blocking alternatives would still need this note:)
  in RPC mode the community extension awaits a dialog answer
  that pi-acp never delivers.
- **Agent → client response channel (gap 2)** — *not needed*
  by the recommendation, but it's why the blocking alternatives
  are expensive: the bridge (`acp-spawn.mjs`) treats a POST with
  `id`-but-no-`method` as a new request (504 after 30s); its
  pending map keys on bare `id` (collision hazard with the
  agent's own request ids); voir's `AcpClient` has no
  `onRequest/respond` and drops unknown methods. Any future
  `session/request_permission` support would fix these first.
- **No approvals** (gap 3) — unchanged; voir renders no
  `session/request_permission` UI. The merged `ask_user`'s
  description explicitly says "NOT for permission dialogs".
- **Context signals** (gap 4) — mostly unneeded for ask_user
  (mode branching suffices). Still useful: acp-spawn already
  injects env (`env: { ...process.env, ACP_FOLDER }`), so
  `VOIR=1` is one line if a tool ever needs voir-detection;
  `PI_CODING_AGENT_DIR` exists if a profile is ever wanted.

## What "ask voir question" becomes

The exclusive-tool case largely **collapses into `ask_user`**:
"ask the phone user a question with a card" *is* the sentinel
path. What remains genuinely voir-exclusive is affordance, not
tool surface: push, voice answering, the card renderer — all
host-side. If a true exclusive tool emerges (e.g.
`notify_user` — fire a push without a turn), the mechanisms
are, in order of preference:

1. **Env-gated registration** in a normal extension
   (`VOIR=1` → register; terminal → don't). One file, no
   profile, no drift; exclusivity via the launcher's env.
2. **Full voir profile** (`PI_CODING_AGENT_DIR=~/.pi/voir`
   when the dir exists, + `PI_CODING_AGENT_SESSION_DIR`
   pointing back at the shared session store — critical or
   the two-way.md session hand-off breaks). Needed only when
   whole *resources* must differ (system-prompt additions
   ("you're on a phone"), default tool sets, voir-only slash
   commands — pi-acp reads prompts from the same agent dir).
3. **voir as MCP server** — the agent-agnostic end state for
   codex/opencode under voir; reuses voir's question
   endpoints; blocked on pi-acp's unwired `mcpServers` (or
   per-agent config) for pi.
4. **ACP elicitation / `session/request_permission`** — the
   protocol-standard blocking version; upstream pi-acp work
   (bridge dialogs → elicitation forms, `confirm` →
   request_permission). Optional, ecosystem-flavored (helps
   stock dialog extensions under Zed); not on voir's critical
   path now that the sentinel pattern exists.

## Phasing (revised)

1. **Merged extension — DONE** (see "Phase 1 — as built").
2. **voir card — DONE** (see "Phase 2 — as built"). The push
   body tweak (question excerpt instead of sentinel text) is
   the only remainder, folded into the optional Phase 3.
3. **Optionally later** — push body = the question; env-gated
   exclusive tools; the voir profile for system-prompt
   guidance; voir MCP server for other agents; upstream
   elicitation bridging.

## Phase 2 — as built (voir host side)

What the parked `voir_ask_user` README described as the host
contract, now real in voir:

- **`rawInput` flows** (`chat-types.ts` + `sessions.server.ts`):
  the tool ChatMessage carries the raw tool input; the card
  parses it defensively (`parseAskUserInput` in `Message.tsx`)
  and falls back to the generic tool outline for anything
  unparseable — foreign schemas, streamed partials, unknown
  tools.
- **Question card** (`Message.tsx` → `QuestionCard`): renders
  questions with tappable option buttons (label +
  description). One single-select question → tap sends
  immediately (fewest taps on a phone). Multi-select or
  several questions → selections collect, a "Send answers"
  button appears once every optioned question has one; the
  message is numbered per question ("1. PostgreSQL\n2. …").
  Free-text questions point at the composer ("answer in the
  composer below") — the composer is always available for
  custom answers and interruptions.
- **Answers send through the normal chat action** — same
  FormData contract as the composer and voice mode
  (`intent=send`, payload `{text, resources}`), so the answer
  is a plain user message: it queues normally behind a busy
  turn, lands in the transcript, and replays with the
  session.
- **Answered state is transcript-derived** (`ChatView`): a
  card is collapsed ("answered in a follow-up message") once
  any user message follows it — live and on replay, so old
  questions can't be answered twice and no extra durable
  state exists.
- **End-to-end verified** against a live stack (dev server on
  :9001, acp-spawn + pi-acp in a scratch worktree): prompt →
  tool call arrives with `rawInput.questions` + sentinel
  content + `status: completed` (no hang); answer POSTed the
  way the card sends it → pi continues treating it as the
  answer ("Noted — PostgreSQL it is…"); SSR renders collapsed
  cards for answered questions. `npm run typecheck` and the
  50-test suite pass.

## Phase 1 — as built

Installed at `~/.pi/agent/extensions/ask-user/` (replacing the
community copy in place), verified:

- **Print mode**: `pi -p` call → pending-questions.json
  written, tool result points at it.
- **RPC mode**: harness over `pi --mode rpc` → tool completes
  immediately with the sentinel text,
  `details.viaFollowUp: true`, `mode: "rpc"`, empty answers;
  `agent_settled` fires — **no hang**, no stray
  `setWidget` traffic.
- **TUI** (tmux harness): widget card renders above the
  composer and **persists while the question is pending**;
  submitting the answer clears it (via the `agent_start`
  handler) and the model treats the message as the answer.
  Two wrong events ruled out on the way: `turn_start` fires
  per model invocation (cleared the card mid-turn) and
  `ui_prompt_start` only fires for blocking dialogs (never
  fired at all).
- Registered as `ask_user`; mode-neutral `promptGuidelines`
  (registration can't detect runtime mode, so the branch
  contract lives in the tool result text); `renderResult`
  handles the sentinel case for sessions replayed in the
  TUI.
- **TUI default is now the sentinel card**, with arrow-key
  modal dialogs opt-in via `ASK_USER_DIALOGS=1` — chosen for
  the uniform, cross-runtime transcript shape (asked in a
  terminal, answered after reopening in voir; the dialog
  variant leaves a dangling `tool_use` in the session when
  interrupted, which providers reject).

What was *not* built at Phase 1 — the voir host side — landed
as Phase 2 (below): ask_user under voir now renders as the
card and answers as normal messages. The one leftover: the
settle-push body for a turn that asked a question still
carries the default excerpt (the sentinel text) rather than
the question itself; folded into Phase 3.

## Open questions

1. ~~Tool name~~ — resolved: `ask_user`, merged, the `voir_`
   prefix retired; the parked dir is deleted.
2. Answer message format: voir-composed explicit "Q1/A1"
   blocks (recommended — unambiguous for the model) vs
   letting the user free-type (the guidelines handle both,
   but explicit is safer).
3. Should the card disable/suppress free-text in the composer
   while a question is open? Lean: no — interrupting a
   question must stay possible.
4. multiSelect: render checkboxes on the card and join
   selections in the answer text; the model sees a
   comma-separated list. Sufficient?
5. The card shows while the turn is still running (tool result
   arrives seconds later, turn ends) — fine? The turn's
   remaining output can follow the card; the composer's queue
   semantics already handle follow-ups.
6. Upstream appetite: offer the merged extension (or the
   sentinel pattern) to pi-agent-extensions as the canonical
   ACP-mode ask_user, so Zed users benefit too? The README of
   the parked extension was already written with any-host
   ambitions.
7. ~~Delete the parked `extensions-voir/` dir once merged~~ —
   done; the wire contract lives in the merged extension's
   README, the dir is removed.