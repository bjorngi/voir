# AGENTS.md — AI Agent Guide for voir

Voir is the chat host you may be talking through right now: a mobile-first
chat UI for ACP-compatible coding agents (see README). This file is for
agents working ON voir itself.

## Key documents

- `README.md` — run it, attach agents, security posture
- `skills/voir-platform/SKILL.md` — the host from the attached agent's
  side (inbox, session model, push, capabilities)
- `skills/voir-rich/SKILL.md` — the rich-content module registry
  (cards, charts, mermaid, sandboxes) with full schemas
- `docs/` — design docs per subsystem (two-way, session-status,
  images-and-share, search, sandbox, supervisor)
- `bin/dev.mjs` header — the mock dev stack, and how it isolates itself

## Running

```sh
npm run dev          # vite dev server on 127.0.0.1:9000 (real agents attach via acp-spawn)
npm run dev:mock     # same + two seeded mock agents (project-a / project-b)
```

Prefer `dev:mock` for UI work: every renderable thing (streaming, thoughts,
tool calls, inline diffs, mermaid, charts, cards, tables, ha chips,
sandboxes, model drawer, archived sessions, "Working on") is on screen with
no agent binary. The stack isolates `VOIR_DATA_DIR` to `dev-data/runtime/`
and disables faro/OTel, so it is safe next to the production instance
(`bin/server.ts`, port 10001 on the devbox). The two mocks carry distinct
seed sets (`MOCK_VARIANT=a|b`, see `bin/mock-acp.mjs`); seed ids are
variant-namespaced because voir dispatches session updates by sessionId
across ALL agents — ids must be globally unique, the way real UUIDs are.

## Verifying yourself

Before claiming any work done:

```sh
npm run test         # node:test unit suite (server logic)
npm run test:e2e     # Playwright walkthrough — boots its own dev:mock stack on :9300
npm run typecheck    # react-router typegen && tsc
```

The walkthrough (`test/e2e/walkthrough.spec.ts`) is the redesign net: ten
steps through the app's whole surface, ~45s, fresh stack per run. When a
selector there has to change, treat it as a lost affordance, not test
churn. Two dev-mode traps it encodes: SSR content renders before React
hydrates (wait for `networkidle` before interacting after full loads), and
full page loads log hydration mismatches — known debt, don't paper over
it in tests.

For interactive verification use the Playwright MCP against the running
app. On the devbox it is wired as the `voir-browser` server via this
repo's `.pi/mcp.json` (http://localhost:8932/mcp — project-scoped, so it
shows up in sessions working in this repo); launch it with:

```sh
npm run mcp:browser  # npx @playwright/mcp --port 8932 --browser chromium --user-data-dir …
```

(`--browser chromium` matters — the chrome channel isn't installed; the
browser cache lives in `~/.cache/ms-playwright`. The dedicated
`--user-data-dir` keeps voir's browser profile separate from other
playwright-mcp instances on the box, e.g. budget's on :8931 — without it
two servers fight over the same profile and the second refuses to start.
The server is a plain process, not a service: check `ss -tln | grep 8932`
and restart with `npm run mcp:browser` if it's down.)

Drive the mock stack with it: resize to 390×844, walk home → folder →
session, send a turn, screenshot into `shots/` (gitignored).
