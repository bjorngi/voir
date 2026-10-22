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
//   --name <name>     label shown in the UI (optional — a random
//                     agent-<hex> name is generated when omitted)
//   --ui   <url>      UI / orchestrator base URL (required)
//   --port <n>        explicit port (default: pick a free one)
//   --no-register     start the bridge only, don't talk to the UI
//   --sse-lifetime <ms>  test aid: forcibly end each SSE stream
//                       after <ms>, simulating proxy timeouts /
//                       network drops so the UI's reconnect+resync
//                       path can be exercised end to end
//   -h, --help
//
// Lifecycle: spawn → wait for ready → register → wait for SIGINT/SIGTERM
//            → unregister → kill child → exit 0.
//
// The process plumbing lives in bin/acp-lib.mjs (shared with the
// resident supervisor); this file is the one-shot policy: one
// agent, one bridge, register, die with the terminal.

import {
  launchAgent,
  createRegistrar,
  randomName,
} from "./acp-lib.mjs";

/**
 * console.* writes to pipes are asynchronous; a bare
 * process.exit() right after can truncate the output (error
 * messages, --help). Drain stdout+stderr, then exit. Throws a
 * Fatal to unwind — an exit that only SCHEDULES lets execution
 * continue past the call site until the callback fires.
 */
class Fatal extends Error {}
function exitAfterFlush(code) {
  process.stdout.write("", () =>
    process.stderr.write("", () => process.exit(code)),
  );
  throw new Fatal(`exit(${code})`);
}

// -----------------------------------------------------------------------
// Args
// -----------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    agent: process.env.AGENT ?? null,
    name: process.env.NAME ?? null,
    ui: process.env.UI ?? null,
    port: process.env.PORT ? Number(process.env.PORT) : null,
    // The interface the bridge listens on. Default to loopback so
    // the on-host case stays secure-by-default; containerized
    // launchers pass --bind 0.0.0.0 (or the specific container IP)
    // to be reachable from the UI in another network namespace.
    bind: process.env.BIND ?? "127.0.0.1",
    // The URL the bridge advertises to the UI. Defaults to
    // http://<bind>:<port>/, which is correct when the UI and the
    // launcher share a network namespace (the on-host case). In
    // containerized setups the UI sees the agent under a different
    // hostname (e.g. the compose service name), so the launcher
    // should pass --url to override what gets registered.
    url: process.env.URL ?? null,
    register: true,
    sseLifetime: process.env.SSE_LIFETIME ? Number(process.env.SSE_LIFETIME) : null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") opts.agent = argv[++i];
    else if (a === "--name") opts.name = argv[++i];
    else if (a === "--ui") opts.ui = argv[++i];
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--bind") opts.bind = argv[++i];
    else if (a === "--url") opts.url = argv[++i];
    else if (a === "--no-register") opts.register = false;
    else if (a === "--sse-lifetime") opts.sseLifetime = Number(argv[++i]);
    else if (a === "-h" || a === "--help") {
      printHelp();
      exitAfterFlush(0);
    } else {
      console.error(`unknown flag: ${a}`);
      printHelp();
      exitAfterFlush(2);
    }
  }
  const missing = [];
  if (!opts.agent) missing.push("--agent");
  if (!opts.ui) missing.push("--ui");
  if (missing.length > 0) {
    console.error(`missing required flag(s): ${missing.join(", ")}`);
    printHelp();
    exitAfterFlush(2);
  }
  // --name is optional: unnamed spawns get a generated identity
  // (agent-<6 hex>), so several ad-hoc agents can share a
  // worktree without anyone inventing names.
  opts.name ??= randomName();
  return opts;
}

function printHelp() {
  console.log(`Usage: acp-spawn --agent <spec> [--name <name>] --ui <url> [options]

Spawns an ACP-compatible agent in the current directory, exposes it as an
ACP JSON-RPC 2.0 HTTP endpoint, and registers it with the UI / orchestrator
at --ui.

Options:
  --agent <spec>    agent command + args     (required)
                    split on whitespace, e.g. --agent "opencode acp"
  --name <name>     display name in the UI
                                       [default: generated agent-<6 hex>]
  --ui   <url>      UI / orchestrator base URL (required)
                    used to POST /api/folders and DELETE on shutdown
  --port <n>        local bridge port        [default: pick a free port]
  --bind <addr>     interface the bridge listens on
                                       [default: 127.0.0.1, use 0.0.0.0
                                        in containers]
  --url  <url>      URL the bridge advertises to the UI
                                       [default: http://<bind>:<port>/,
                                        override when the UI reaches the
                                        agent under a different name
                                        (e.g. a compose service name)]
  --no-register     don't talk to the UI (bridge only)
  --sse-lifetime <ms>  test aid: end each SSE stream after <ms>
  -h, --help

Environment (used as fallback for the corresponding flag):
  AGENT             same as --agent
  NAME              same as --name
  UI                same as --ui
  PORT              same as --port
  BIND              same as --bind
  URL               same as --url
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const folder = process.cwd();

  // ---------------------------------------------------------------------
  // Launch + register
  // ---------------------------------------------------------------------
  let shuttingDown = false;
  let registrar = null;
  let agent = null;

  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      registrar?.stop();
      await registrar?.unregister();
    } catch {}
    agent?.stop();
    setTimeout(() => process.exit(code), 200);
  }

  agent = await launchAgent({
    spec: opts.agent,
    cwd: folder,
    bind: opts.bind,
    port: opts.port,
    url: opts.url,
    sseLifetime: opts.sseLifetime,
    label: opts.name,
    onChildExit: (code, signal) => {
      if (shuttingDown) return;
      console.error(
        `[${opts.agent}] exited unexpectedly code=${code} signal=${signal}`,
      );
      shutdown(1);
    },
  });

  console.log(`${opts.agent} bridge for ${folder} on ${agent.agentUrl}`);

  if (opts.register) {
    registrar = createRegistrar({
      ui: opts.ui,
      folder,
      agentUrl: agent.agentUrl,
      agentName: opts.name,
    });
    await registrar.register();
    registrar.keepRegistered();
  }

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => shutdown(0));
  }
}

main().catch((err) => {
  // exitAfterFlush() already scheduled the exit; a Fatal here is
  // the halt, not a failure to report.
  if (err instanceof Fatal) return;
  console.error(err?.stack || String(err));
  process.exit(1);
});