#!/usr/bin/env node
// mock-acp — a tiny in-memory stand-in for an ACP-compatible agent.
//
// Used by docker-compose for local development. acp-spawn launches this
// as a child process and bridges its stdio to HTTP, exactly the way
// it would bridge `pi-acp` or `opencode acp`:
//
//   - reads JSON-RPC 2.0 requests, one per line, on stdin
//   - writes JSON-RPC 2.0 responses on stdout (newline-delimited)
//   - writes JSON-RPC 2.0 notifications on stdout too; acp-spawn
//     forwards these to its SSE clients, which is how the chat UI
//     sees streaming chunks
//
// The point is to have the chat UI do something interesting without
// requiring a real agent binary, an API key, or a network round-trip.
//
// Behaviour:
//   - initialize            → protocolVersion 1 + minimal capabilities
//   - session/new, /load    → canned sessionId, fake model & mode lists
//   - session/prompt        → stream a few agent_message_chunk
//                              notifications, then resolve with
//                              { stopReason: "end_turn" }
//   - session/set_model,
//     session/set_mode      → ack with the chosen id, plus a
//                              current_*_update notification
//   - session/cancel        → ack
//   - session/list          → return the sessions we've created
//   - session/resume        → ack
//   - ping                  → { ok: true }
//
// Streaming cadence is deliberately slow (a small delay between chunks)
// so the chat UI's "streaming" cursor is visible during a turn.

import { randomUUID } from "node:crypto";

// ── canned data ─────────────────────────────────────────────────────
const MODELS = [
  {
    modelId: "mock/cheery-1",
    name: "Cheery 1 (mock)",
    description: "A cheerful, lightweight mock model.",
  },
  {
    modelId: "mock/cryptic-2",
    name: "Cryptic 2 (mock)",
    description: "Speaks in riddles. For vibes.",
  },
];
const MODES = [
  { id: "off", name: "Off", description: "No thinking." },
  { id: "low", name: "Low", description: "A little thinking." },
  { id: "high", name: "High", description: "Lots of thinking." },
];

// Slash commands advertised on every new/loaded session. The
// chat surfaces these in the `/` popover; sending one to the
// mock is a no-op (the mock doesn't expand commands — the
// chat treats them as plain text, so typing `/help` is the
// same as typing the literal four characters + a space).
const COMMANDS = [
  {
    name: "help",
    description: "List the commands this agent supports.",
  },
  {
    name: "compact",
    description: "Summarize older turns to free context window.",
    inputHint: "optional focus area",
  },
  {
    name: "init",
    description: "Scaffold a project description from the worktree.",
  },
  {
    name: "clear",
    description: "Start a fresh session in this folder.",
  },
  {
    name: "status",
    description: "Show the current model, mode, and session id.",
  },
];

// Pre-seeded sessions: the mock pretends these existed before
// the user opened the dev compose, so `session/list` returns
// something interesting on first load and the folder view in
// Voir shows more than just "+ New chat". Each seed gets a
// stable id (slug + index) so re-opening the same session
// after a server round-trip finds the same record.
const SEED_SESSIONS = [
  { title: "What is Voir?", minutesAgo: 5 },
  { title: "Refactor auth middleware", minutesAgo: 18 },
  { title: "Fix flaky E2E tests", minutesAgo: 47 },
  { title: "Add a /health endpoint", minutesAgo: 90 },
];

// History for each seeded session, replayed as a stream of
// session/update notifications when the user opens it. The
// shape mirrors what a real agent would replay on
// session/load: a sequence of user messages, agent thoughts,
// agent text, and tool calls. The chat coalesces consecutive
// `agent_message_chunk`s into a single message and renders
// tool calls as inline diffs (when the content is a `diff`
// block) or text (when it's a `content` block).
//
// Delays are small (10–40ms) so the replay feels like a
// fast-forwarded "loading the transcript" rather than a
// prompt-time stream. The end-of-replay signal is the
// `available_commands_update` notification — the chat's
// `loadSession` waits for the first non-chunk event before
// returning.
const SEED_HISTORY = {
  // A long, conversational tour of the project. The user
  // attaches @README.md so the agent reads it first; the rest
  // of the conversation is a Q&A covering what the project is,
  // what it isn't, the workflow, security caveats, and where
  // it stops being a finished product. Drawn from the same
  // material as the README, but in plain prose with the agent
  // admitting uncertainty and being opinionated where the
  // README is vague.
  "What is Voir?": [
    { kind: "user", text: "What is Voir? I'm new here. @README.md" },
    {
      kind: "thought",
      text: "Let me read the README first so I'm not making this up from memory.",
    },
    {
      kind: "tool",
      toolCallId: "tc-readme-1",
      toolKind: "read",
      title: "Read README.md",
      status: "in_progress",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text:
              "# Voir\n\n" +
              "A chat interface for ACP-compatible coding agents. One screen, one " +
              "conversation per session, mobile-first.\n\n" +
              "Voir does one thing: it talks JSON-RPC 2.0 to ACP agents and renders the " +
              "chat. It does not spawn agents, it does not run agents, and it does not " +
              "kill agents. That's the launcher's job.\n\n" +
              "[...] full README continues: Run it, Pick an ACP agent and add a chat, " +
              "Multiple sessions in one worktree, Add more chats, Tear down, Sandbox " +
              "the agent, Security: this is your job, What it is and isn't, Commands, " +
              "License.",
          },
        },
      ],
    },
    {
      kind: "tool_update",
      toolCallId: "tc-readme-1",
      status: "completed",
    },
    {
      kind: "agent",
      text:
        "Short version: Voir is a chat interface for ACP-compatible coding agents " +
        "— the kind of agents that speak the [Agent Client Protocol](https://agentclientprotocol.com). " +
        "It's a mobile-friendly chat UI that talks JSON-RPC 2.0 to whatever agent you point it at. " +
        "It does not spawn the agent, run the agent, or kill the agent — that part lives in a separate " +
        "launcher (`acp-spawn`) running on the host. Voir's job is just the conversation: render the " +
        "chat, stream the replies, show the diff of what the agent changed in the worktree.",
    },
    {
      kind: "user",
      text: "OK so what does it actually do day-to-day? Like, what's the workflow?",
    },
    {
      kind: "thought",
      text: "Concrete example would help. Let me describe what the user sees when they open the app.",
    },
    {
      kind: "agent",
      text:
        "You open it in a browser (or on a phone, it's mobile-first), and the first thing you see is a " +
        "list of folders. Each folder is a worktree on your machine, with an ACP-compatible agent attached " +
        "to it. Pick a folder, pick one of the sessions, type into the composer, hit send. The reply " +
        "streams in chunk by chunk — the chat shows a live cursor while the agent is still thinking. " +
        "There are a few extras: type `/` to see slash commands the agent advertises (`/compact`, `/init`, " +
        "that kind of thing); type `@` to attach a file from the worktree to your next message; the chevron " +
        "above the composer opens a drawer to switch the model mid-conversation. After the agent edits " +
        "some files, the worktree's **Diff** tab shows you exactly what it changed.",
    },
    {
      kind: "user",
      text: "And what doesn't it do? That list is usually more interesting.",
    },
    {
      kind: "thought",
      text: "Honesty about scope is the whole point. The README has a section called 'What it is and isn't' — let me lean on that.",
    },
    {
      kind: "agent",
      text:
        "Right. It does not create worktrees. It does not run or supervise the agent process. It does " +
        "not sandbox the agent. It does not authenticate users. It does not have a database — sessions " +
        "live in the agent's own storage and the launcher just tells Voir which endpoints to talk to. " +
        "The mobile chat shell is meant to be the smallest unit that's actually usable on a phone; " +
        "anything more ambitious — multi-agent orchestration, complex tool-approval flows, a hosted " +
        "version with proper auth — is something you'd build on top. The repo puts it bluntly: *this is " +
        "the smallest unit that does mobile development. You write the tooling.*",
    },
    {
      kind: "user",
      text: "How do I actually add a real agent? Is it a config file or…",
    },
    {
      kind: "thought",
      text: "There's a CLI for it. Let me sketch the shape of the call.",
    },
    {
      kind: "agent",
      text:
        "It's a CLI, not a config file. You `cd` into the worktree you want to chat with, then run " +
        "`acp-spawn --agent <whatever> --name <label> --ui http://localhost:9000`. The `<whatever>` is " +
        "any ACP-compatible binary — `pi-acp`, `opencode acp`, `claude-agent-acp`, `codex-acp`, " +
        "`copilot-acp`, anything in the [ACP registry](https://agentclientprotocol.com/get-started/agents). " +
        "The launcher spawns the agent, picks a free port, bridges its stdio to an HTTP JSON-RPC endpoint, " +
        "and POSTs to `/api/folders` on Voir to register the folder. The folder appears in the sidebar " +
        "immediately. You can have as many sessions per worktree as you like, and you can have multiple " +
        "agents in the same worktree by running two launchers with different `--name`s — each becomes " +
        "its own folder, with its own session list.",
    },
    {
      kind: "user",
      text: "What about the security caveats in the README? That section looked… pointed.",
    },
    {
      kind: "thought",
      text: "Be honest. The README is direct about this and I should be too.",
    },
    {
      kind: "agent",
      text:
        "It is pointed, on purpose. Out of the box Voir has no auth, binds the dev server to `0.0.0.0` " +
        "(so `npm run dev` is reachable on your LAN — fine in a container, not fine on a laptop), and " +
        "will fetch any `agentUrl` it's told to via `POST /api/folders` — meaning an attacker who can " +
        "reach the server can make it talk to internal services. The intended setup is: you run Voir " +
        "on 127.0.0.1 or behind a reverse proxy (Caddy, nginx, Traefik, Cloudflare Tunnel) with " +
        "whatever auth fits. It's not that Voir can't be exposed; it's that the author didn't want " +
        "to ship a half-baked auth layer and call it done. Sandboxing the agent is also the launcher's " +
        "job — you can wrap the agent in `fence` or `bwrap` or `firejail` before `--agent` and the " +
        "launcher will run whatever command you give it.",
    },
    {
      kind: "user",
      text: "If I want to use this from my phone, what's actually involved?",
    },
    {
      kind: "thought",
      text: "The mobile-friendly chat shell is the headline feature. Let me walk through the pieces that have to line up.",
    },
    {
      kind: "agent",
      text:
        "A few things have to line up. First, the dev server has to be reachable from your phone — " +
        "the easiest paths are `tailscale` or a Cloudflare Tunnel in front of Voir, with HTTP basic " +
        "auth or OIDC at the tunnel. Second, you need an agent running somewhere the phone can talk to; " +
        "the chat streams via SSE and the bridge is plain HTTP, so any path that lets the phone reach " +
        "the bridge port works. Third, you need a way to start a new session from the phone — the " +
        "launcher is a CLI on the host, so usually that means SSH-ing in to run `acp-spawn …`, or " +
        "wiring it up so a session is already attached to whatever worktree you want to talk to. " +
        "After that, the chat itself is fine on a phone: full-width tap targets, the slash menu and " +
        "the file picker work in mobile Safari and Chrome, the composer has a 44px send button.",
    },
    {
      kind: "user",
      text: "Is this done, or is there more to build?",
    },
    {
      kind: "thought",
      text: "Real answer: the chat shell is the minimum. The repo is honest about that, I should be too.",
    },
    {
      kind: "agent",
      text:
        "It's the minimum. The mobile chat shell is the smallest unit that's actually usable on a " +
        "phone. Everything else — orchestrating multiple agents, parallel sessions, fancier tool " +
        "approval, persisted history across agent restarts — is upstream of this. The repo is more " +
        "an invitation to build the rest of the stack than a finished product. If you want to compare " +
        "two agents in the same worktree, or attach three sessions to three different worktrees, or " +
        "run it from your phone while your laptop is closed, that all works today. If you want a " +
        "hosted multi-tenant version with proper auth and a session log, you'll be writing that.",
    },
  ],
  "Refactor auth middleware": [
    { kind: "user", text: "Move the JWT verify call out of every route handler." },
    {
      kind: "thought",
      text: "I should grep for verifyJwt call sites and find the common shape before refactoring.",
    },
    {
      kind: "agent",
      text: "Found 14 places that call `verifyJwt` directly. I'll add a `requireAuth` middleware in `src/middleware/auth.ts` and have the routes import that instead.",
    },
    {
      kind: "tool",
      toolCallId: "tc-auth-1",
      toolKind: "read",
      title: "Read src/middleware/auth.ts",
      status: "in_progress",
      content: [],
    },
    {
      kind: "tool_update",
      toolCallId: "tc-auth-1",
      status: "completed",
    },
    {
      kind: "agent",
      text: "Middleware is in place. The diff swaps 14 inline calls for one `requireAuth(req, res, next)` per route — net −40 lines.",
    },
  ],
  "Fix flaky E2E tests": [
    { kind: "user", text: "Tests timing out on CI when the worker pool is full." },
    {
      kind: "thought",
      text: "Likely port allocation. Let me check the playwright config first.",
    },
    {
      kind: "agent",
      text: "Confirmed — the tests were binding to fixed ports (`3000`, `3001`, …). Switching to dynamic allocation via `port: 0` so the OS picks free ones.",
    },
    {
      kind: "tool",
      toolCallId: "tc-e2e-1",
      toolKind: "edit",
      title: "Edit playwright.config.ts",
      status: "in_progress",
      content: [
        {
          type: "diff",
          path: "playwright.config.ts",
          oldText: "  use: {\n    baseURL: 'http://localhost:3000',\n    port: 3000,\n  },",
          newText: "  use: {\n    baseURL: 'http://localhost:0',\n    port: 0,\n  },",
        },
      ],
    },
    {
      kind: "tool_update",
      toolCallId: "tc-e2e-1",
      status: "completed",
    },
    {
      kind: "agent",
      text: "Pushed. CI re-ran 3×, no timeouts. If it still flakes we can add `fullyParallel: false` as a follow-up.",
    },
  ],
  "Add a /health endpoint": [
    { kind: "user", text: "Need a /health route for k8s liveness and readiness." },
    {
      kind: "agent",
      text: "Adding `src/routes/health.ts` — returns `200 { status: 'ok' }` for both probes. No auth, no DB call.",
    },
    {
      kind: "tool",
      toolCallId: "tc-health-1",
      toolKind: "write",
      title: "Write src/routes/health.ts",
      status: "in_progress",
      content: [
        {
          type: "diff",
          path: "src/routes/health.ts",
          oldText: "",
          newText:
            "import { Router } from 'express';\n\nconst router = Router();\nrouter.get('/health', (_req, res) => {\n  res.json({ status: 'ok' });\n});\n\nexport default router;\n",
        },
      ],
    },
    {
      kind: "tool_update",
      toolCallId: "tc-health-1",
      status: "completed",
    },
    {
      kind: "agent",
      text: "Mounted at `/health`. The readiness probe is the same as liveness for now — when we add a DB pool I'll split them.",
    },
  ],
};

const REPLIES = [
  "Got it — I'm a mock agent, so I can't actually do anything with the worktree, but the streaming and chat UI are real end-to-end. ✔",
  "Hello from mock-acp! This response is being streamed over SSE, just like a real ACP agent would. The chunked text appears incrementally in the chat.",
  "Things to try:\n  • type `@` to attach a file mention\n  • open the model drawer (chevron above the composer) and pick a different one\n  • start a second chat in the same folder with **+ New chat**",
  "If you stop the `acp-spawn` container, Voir's heartbeat will notice within ~10 seconds and drop this folder from the sidebar.",
];
let replyIndex = 0;
function nextReply() {
  const r = REPLIES[replyIndex % REPLIES.length];
  replyIndex++;
  return r;
}

const STREAM_DELAY_MS = Number(process.env.MOCK_STREAM_DELAY_MS ?? 120);
const sessions = new Map(); // sessionId → { cwd, createdAt, title? }

// Pre-populate the session map with the seeds. The id is
// derived from the title so it's stable across mock restarts
// within a single boot (good enough — the mock is short-
// lived).
function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
{
  const cwd0 = process.cwd();
  for (let i = 0; i < SEED_SESSIONS.length; i++) {
    const seed = SEED_SESSIONS[i];
    const id = `seed-${slug(seed.title)}`;
    sessions.set(id, {
      cwd: cwd0,
      createdAt: Date.now() - seed.minutesAgo * 60_000,
      title: seed.title,
    });
  }
}

// ── stdout framing ──────────────────────────────────────────────────
function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Replay a seeded session's history as a stream of
// session/update notifications. Each event arrives ~30ms
// after the previous one, so the chat shows the transcript
// assembling in real time rather than all at once. The
// end-of-replay signal (a non-chunk event, normally
// `available_commands_update`) is pushed by the caller
// afterwards so the chat's `loadSession` waiter can resolve.
async function replayHistory(sessionId, title) {
  const script = SEED_HISTORY[title];
  if (!script) return;
  for (const ev of script) {
    if (ev.kind === "user") {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: ev.text },
        },
      });
    } else if (ev.kind === "thought") {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: ev.text },
        },
      });
    } else if (ev.kind === "agent") {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: ev.text },
        },
      });
    } else if (ev.kind === "tool") {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: ev.toolCallId,
          kind: ev.toolKind,
          title: ev.title,
          status: ev.status,
          content: ev.content,
        },
      });
    } else if (ev.kind === "tool_update") {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: ev.toolCallId,
          status: ev.status,
        },
      });
    }
    await sleep(30);
  }
}

// ── request handlers ────────────────────────────────────────────────
const handlers = {
  initialize({ protocolVersion }) {
    return {
      protocolVersion: protocolVersion ?? 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { list: true, resume: true },
      },
      agentInfo: { name: "mock-acp", title: "Mock ACP", version: "0.1.0" },
      authMethods: [],
    };
  },

  "session/new"({ cwd }) {
    const id = randomUUID();
    sessions.set(id, { cwd, createdAt: Date.now() });
    return {
      sessionId: id,
      models: { currentModelId: MODELS[0].modelId, availableModels: MODELS },
      modes: { currentModeId: MODES[0].id, availableModes: MODES },
    };
  },

  "session/load"({ sessionId, cwd }) {
    const id = sessionId ?? randomUUID();
    const existing = sessions.get(id);
    sessions.set(id, {
      cwd,
      createdAt: existing?.createdAt ?? Date.now(),
      title: existing?.title,
    });
    return {
      sessionId: id,
      models: { currentModelId: MODELS[0].modelId, availableModels: MODELS },
      modes: { currentModeId: MODES[0].id, availableModes: MODES },
    };
  },

  "session/resume"({ sessionId }) {
    return { sessionId };
  },

  "session/list"({ cwd }) {
    return {
      sessions: Array.from(sessions.entries())
        .filter(([, s]) => !cwd || s.cwd === cwd)
        .map(([sessionId, s]) => ({
          sessionId,
          // Seeded sessions carry their own title; live
          // sessions fall back to a stable placeholder so the
          // sidebar is never empty.
          title: s.title ?? `Mock session ${sessionId.slice(0, 8)}`,
          updatedAt: new Date(s.createdAt).toISOString(),
          cwd: s.cwd,
        })),
    };
  },

  "session/cancel"() {
    return {};
  },

  "session/set_mode"({ sessionId, modeId }) {
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: modeId },
    });
    return { modeId };
  },

  "session/set_model"({ sessionId, modelId }) {
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "current_model_update", currentModelId: modelId },
    });
    return { modelId };
  },

  async "session/prompt"({ sessionId, prompt }) {
    // Echo a short thought, then a streamed reply, then end the turn.
    // The delays make the chat UI's streaming cursor visible.
    const userText = (prompt ?? [])
      .map((c) => (c?.type === "text" ? c.text : ""))
      .filter(Boolean)
      .join(" ")
      .trim();

    if (userText) {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: `You said: "${userText.slice(0, 80)}".\n` },
        },
      });
      await sleep(STREAM_DELAY_MS);
    }

    const reply = nextReply();
    // Stream the reply in small chunks, ~30 chars at a time. The
    // chat client coalesces chunks into a single message by
    // checking the "streaming" flag on the previous message, so
    // we don't need to thread a stable id through here.
    const chunkSize = 30;
    for (let i = 0; i < reply.length; i += chunkSize) {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: reply.slice(i, i + chunkSize) },
        },
      });
      await sleep(STREAM_DELAY_MS);
    }

    if (!userText) {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "(empty prompt — say something and I'll echo it.)",
          },
        },
      });
    }

    return { stopReason: "end_turn" };
  },

  ping() {
    return { ok: true };
  },
};

async function dispatch(req) {
  const { id, method, params } = req;
  const fn = handlers[method];
  if (!fn) {
    respondError(id, -32601, `Method not found: ${method}`);
    return;
  }
  try {
    const result = await fn(params ?? {});
    respond(id, result);
    // After a successful new/load, push the slash-command
    // list and (for seeded sessions) the title as
    // session/update notifications. The chat reads slash
    // commands only from these notifications (not from the
    // response body), and the title for an opened session
    // is what the user sees in the chat header. Doing this
    // here keeps every session's command list consistent
    // without each handler having to remember.
    if (method === "session/new" || method === "session/load") {
      const sessionId = result?.sessionId;
      if (sessionId) {
        // The chat processes the HTTP response and adds the
        // session to its in-memory map in the same microtask
        // it resolves the fetch. The SSE notification races
        // that microtask: if the notification's handler runs
        // first, `findSession` returns undefined and the
        // notification is dropped. Defer the notifications
        // 50ms so the chat's HTTP response has time to settle.
        setTimeout(async () => {
          // For seeded sessions, replay the canned history
          // first. The chat's loadSession waits for the
          // first non-chunk event before returning, so the
          // available_commands_update at the end of the
          // script serves as the "replay complete" signal.
          const seed = sessions.get(sessionId);
          if (seed?.title && SEED_HISTORY[seed.title]) {
            await replayHistory(sessionId, seed.title);
          }
          notify("session/update", {
            sessionId,
            update: { sessionUpdate: "available_commands_update", availableCommands: COMMANDS },
          });
          if (seed?.title) {
            notify("session/update", {
              sessionId,
              update: { sessionUpdate: "session_info_update", title: seed.title },
            });
          }
        }, 50);
      }
    }
  } catch (err) {
    respondError(id, -32000, err?.message ?? String(err));
  }
}

// ── stdin framing ───────────────────────────────────────────────────
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // Skip malformed lines. A real agent would log to stderr;
      // we do the same so acp-spawn's prefix shows up in the
      // launcher's stderr stream.
      process.stderr.write(`mock-acp: ignoring malformed JSON: ${line}\n`);
      continue;
    }
    void dispatch(msg);
  }
});

process.stdin.on("end", () => process.exit(0));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => process.exit(0));
}
