---
name: voir-platform
description: How voir (the chat host) works for agents attached to it via ACP/voir — the machine inbox for seeding conversations, session/folder model, push notifications, the file-image seam, upload/serve routes, environment (VOIR/ACP_FOLDER, VOIR_INBOX_TOKEN), and which agent capabilities voir reads (promptCapabilities, model vision _meta). Load when you want to integrate with voir programmatically — seed conversations from scripts/triggers, push content into voir, understand what the host renders or persists, or debug host-agent interaction.
---

# Voir platform — how the host works (agent integration reference)

Voir is a chat UI for ACP agents. Your session runs in a **worktree
folder** (`$ACP_FOLDER` = the folder path, `VOIR=1` marks a voir-launched
agent). One folder can hold many sessions; session ids survive agent
restarts (pi session files are the truth).

## What voir renders in replies (short version)

Fenced blocks + inline spans route through a module registry — full
schemas in the **voir-rich** skill. TL;DR: `mermaid`, `voir-card` (JSON
summary cards with tappable actions), `voir-chart` (series data → chart),
`d3` (your code, sandboxed), `html` (single-file app, sandboxed),
backticked worktree image paths → thumbnails.

## Talking to voir over HTTP (server-side, when you control scripts)

Token: `$VOIR_INBOX_TOKEN` (read it from voir's `.env` if the wrapper
scripts do) — never in URLs or logs.

### Seed a conversation (machine-initiated chat)

```
POST /api/inbox
X-Voir-Token: <VOIR_INBOX_TOKEN>
{ "folder": "<abs worktree path>", "prompt": "…",
  "notify": "on-settle|on-create|both|none", "title": "…",
  "from": "<provenance label>" }
→ 201 { sessionId, folder }
```

Voir creates the session, sends the prompt as the first user turn
(prefixed `[from: …]`), pushes the phone when the turn settles. This is
the universal trigger interface: anything that can make an HTTP call
(cron, HA automations, alert webhooks, **your own tools**) can start a
conversation. Retry on 503/timeout — the agent may be rebooting.

### Push notifications

- `POST /api/notify/test` (no token): body `{ url?, text?, title?, tag?,
  folder?, sessionId? }` — fires a test/deferred push to every
  subscribed device. Use sparingly (it bypasses the inbox; for the
  deferred-quiet-hours pattern the alert bridge does exactly this).
- Push payloads are ≤4KB text-only — no image bytes. The graph-in-push
  pattern is on the roadmap (grafana panel-image URLs).

### Files & images

- `GET /api/folder-file?folder=<abs>&file=<rel>&raw=1` — serves
  worktree images (traversal-checked). Backtick such paths in replies —
  voir thumbnails them automatically.
- `GET /api/folder-file?folder=&file=` — text file contents (the Files
  tab uses this; binaries are described, not delivered).
- `POST /api/uploads` (multipart `file`) — voir-side image store; chat
  attachments ride it. `GET /api/uploads/<id>` serves one back.

### Session state

- `GET /api/session-status` — the "Working on" snapshot (all folders'
  active sessions with live state: working/waiting/fresh/idle/offline).
- `POST /api/session-status` — `{ folder, sessionId, status: "active" |
  "archived" | "none" }` — the curation overlay.

## What voir reads from you (capabilities)

- **initialize**: `agentCapabilities.promptCapabilities.image` gates the
  composer's paperclip — set it true when your runtime can carry image
  content blocks in `session/prompt`.
- **models**: `_meta.piAcp.input` per advertised model (`["text",
  "image"]`) → the model drawer marks vision-capable models (`·
  vision`) and warns when attaching images under text-only ones.
- **transcript**: your `session/update` stream IS the transcript — text,
  tool calls (with `rawInput`, e.g. the ask_user question cards turn
  into tappable option cards), diffs render as inline diffs.

## Conventions worth keeping

- The user's phone may be behind a push, closed app, or deep in reply
  flow. Write replies that stand alone; put the question in the last
  line.
- Machine-seeded conversations carry a `[from: …]` marker on the first
  user turn — it's provenance, not a command.
- Voir is agent-agnostic by design: never assume voir-specific tools
  exist in another host; degradation is always plain markdown.

## Where the implementation lives

`/home/bjorn/code/voir` — docs/: rich-content.md (this domain),
two-way.md (inbox/push design), session-status.md (the overlay),
images-and-share.md (uploads/share). The extension assembles its
system-prompt section from the module guides in
`app/lib/render/registry.ts` (`assembleNudge()`) — modules carry
their own docs; update both in the same change.
