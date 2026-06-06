#!/usr/bin/env node
// acp-spawn — start an ACP-compatible agent in the current working
// directory, expose it as an ACP JSON-RPC 2.0 HTTP endpoint, and
// register it with a UI / orchestrator application.
//
// Designed to be the entry point that any tool (IDE, worktree manager,
// shell) invokes. The current working directory is the worktree, so
// callers do:
//
//     cd /home/me/worktrees/feat-42
//     acp-spawn --agent pi-acp --name pi --ui http://localhost:9000
//
// Flags:
//   --agent <cmd>     agent to spawn (required)
//   --name <name>     label shown in the UI (required)
//   --ui   <url>      UI / orchestrator base URL (required)
//   --port <n>        explicit port (default: pick a free one)
//   --no-register     start the bridge only, don't talk to the UI
//   -h, --help
//
// Lifecycle: spawn → wait for ready → register → wait for SIGINT/SIGTERM
//            → unregister → kill child → exit 0.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";

// -----------------------------------------------------------------------
// Args
// -----------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    agent: process.env.AGENT ?? null,
    name: process.env.NAME ?? null,
    ui: process.env.UI ?? null,
    port: process.env.PORT ? Number(process.env.PORT) : null,
    register: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") opts.agent = argv[++i];
    else if (a === "--name") opts.name = argv[++i];
    else if (a === "--ui") opts.ui = argv[++i];
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--no-register") opts.register = false;
    else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`unknown flag: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  const missing = [];
  if (!opts.agent) missing.push("--agent");
  if (!opts.name) missing.push("--name");
  if (!opts.ui) missing.push("--ui");
  if (missing.length > 0) {
    console.error(`missing required flag(s): ${missing.join(", ")}`);
    printHelp();
    process.exit(2);
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: acp-spawn --agent <spec> --name <name> --ui <url> [options]

Spawns an ACP-compatible agent in the current directory, exposes it as an
ACP JSON-RPC 2.0 HTTP endpoint, and registers it with the UI / orchestrator
at --ui.

Options:
  --agent <spec>    agent command + args     (required)
                    split on whitespace, e.g. --agent "opencode acp"
  --name <name>     display name in the UI   (required)
  --ui   <url>      UI / orchestrator base URL (required)
                    used to POST /api/folders and DELETE on shutdown
  --port <n>        local bridge port        [default: pick a free port]
  --no-register     don't talk to the UI (bridge only)
  -h, --help

Environment (used as fallback for the corresponding flag):
  AGENT             same as --agent
  NAME              same as --name
  UI                same as --ui
  PORT              same as --port
`);
}

const opts = parseArgs(process.argv.slice(2));
const folder = process.cwd();

// -----------------------------------------------------------------------
// Find a free port (if not specified)
// -----------------------------------------------------------------------
async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const port = opts.port ?? (await findFreePort());
const agentUrl = `http://127.0.0.1:${port}/`;

// -----------------------------------------------------------------------
// Spawn the agent
// -----------------------------------------------------------------------
// --agent is a command spec; we split on whitespace so callers can pass
//   --agent pi-acp
//   --agent "opencode acp"
//   --agent "codex-acp --foo bar"
// A single token is treated as just the command (no args). Paths that
// contain spaces inside one argument aren't supported — wrap in a script.
const agentSpec = opts.agent.trim().split(/\s+/).filter(Boolean);
if (agentSpec.length === 0) {
  console.error("--agent value is empty");
  process.exit(2);
}
const [agentCmd, ...agentArgs] = agentSpec;

const child = spawn(agentCmd, agentArgs, {
  cwd: folder,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ACP_FOLDER: folder },
});
child.stderr.on("data", (b) =>
  process.stderr.write(`[${opts.agent}] ${b}`),
);
child.on("error", (err) => {
  if (shuttingDown) return;
  console.error(`[${opts.agent}] failed to start: ${err.message}`);
  console.error(
    `hint: is the agent on PATH? try \`command -v ${agentSpec[0]}\``,
  );
  shutdown(1);
});
child.on("exit", (code, signal) => {
  if (shuttingDown) return;
  console.error(
    `[${opts.agent}] exited unexpectedly code=${code} signal=${signal}`,
  );
  shutdown(1);
});

// -----------------------------------------------------------------------
// JSON-RPC framing on stdout → request responses + SSE notifications
// -----------------------------------------------------------------------
const pending = new Map();
const sseClients = new Set();
let stdoutBuf = "";
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let i;
  while ((i = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, i).trim();
    stdoutBuf = stdoutBuf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    } else if (msg.method) {
      for (const sse of sseClients) {
        try {
          sse.write(`data: ${line}\n\n`);
        } catch {}
      }
    }
  }
});

// -----------------------------------------------------------------------
// HTTP server: POST = JSON-RPC, GET = SSE
// -----------------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.id !== undefined) {
        const id = body.id;
        const p = new Promise((resolve) =>
          pending.set(id, { resolve, ts: Date.now() }),
        );
        child.stdin.write(JSON.stringify(body) + "\n");
        const reply = await Promise.race([
          p,
          new Promise((r) => setTimeout(() => r(null), 30_000)),
        ]);
        if (!reply) {
          res.statusCode = 504;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(reply));
      } else {
        child.stdin.write(JSON.stringify(body) + "\n");
        res.statusCode = 204;
        res.end();
      }
    } else if (req.method === "GET") {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.writeHead(200);
      sseClients.add(res);
      const ka = setInterval(() => {
        try {
          res.write(": ka\n\n");
        } catch {}
      }, 15_000);
      req.on("close", () => {
        clearInterval(ka);
        sseClients.delete(res);
      });
    } else {
      res.statusCode = 405;
      res.end();
    }
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err));
  }
});

server.listen(port, "127.0.0.1", async () => {
  console.log(`${opts.agent} bridge for ${folder} on ${agentUrl}`);

  if (!opts.register) return;

  // Register with the UI
  try {
    const res = await fetch(`${opts.ui}/api/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: folder,
        agentUrl,
        agentName: opts.name,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${text}`);
    }
    const body = await res.json();
    const browse = `${opts.ui.replace(/\/$/, "")}${body.browse}`;
    console.log(`registered → browse: ${browse}`);
  } catch (err) {
    console.error(`failed to register: ${err.message}`);
    shutdown(1);
  }
});

// -----------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------
let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const url = `${opts.ui}/api/folders?path=${encodeURIComponent(folder)}`;
    await fetch(url, { method: "DELETE" });
  } catch {}
  server.close();
  child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 200);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => shutdown(0));
}
