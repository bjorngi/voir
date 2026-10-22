#!/usr/bin/env node
// voir-supervisor — the resident agent supervisor for one machine.
//
// Owns what should be running on this machine and converges to it:
//
//   config  (authored, never written here)
//     { "ui": "https://chat.lab",
//       "presets": { "pi": "pi-acp",
//                    "pi-fenced": "fence exec --private . -- pi-acp" } }
//
//   state   (managed, written here, desired state only)
//     [ { "dir": "/home/me/code/infra", "preset": "pi-fenced" } ]
//
// The state file says what SHOULD exist, not what does; the
// supervisor reconciles memory ↔ file on every event: boot,
// child crash (restart with backoff), state change (start/stop),
// config change (preset edits hot-reload). Sandboxing lives in
// the preset commands; raw command strings never cross the API.
//
// Subcommands:
//   run                    run the daemon (default)
//   add <dir> --preset p [--name n]   launch + persist in state
//   rm <name|dir>          stop + remove from state
//   ls                     list desired + running agents
//
// One-shot agents (plain `acp-spawn`) are invisible here by
// design — the supervisor only manages what the state file claims.
//
// The daemon exposes a loopback HTTP API (default :7420) that the
// CLI (and later the UI's launch flow, if ever) talks to. A small
// discovery file next to the state file lets the CLI find it.

import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { launchAgent, createRegistrar, randomName } from "./acp-lib.mjs";

const DEFAULT_API_PORT = 7420;
const REREGISTER_INTERVAL_MS = 30_000;
const RESTART_BACKOFF_START_MS = 1_000;
const RESTART_BACKOFF_CAP_MS = 30_000;
const UPTIME_RESET_MS = 60_000;
const CRASHES_BEFORE_ERRORED = 10;

// -----------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * A die()/exitAfterFlush() that only scheduled an async exit is
 * not enough: execution would CONTINUE past the call site until
 * the stderr write callback fires (the EADDRINUSE twin used
 * that window to overwrite its sibling's discovery file). Throw
 * a Fatal to unwind; main() swallows it — the exit is already
 * scheduled by the flushed write.
 */
class Fatal extends Error {}

function log(msg) {
  console.log(`[supervisor] ${msg}`);
}

/**
 * console.* writes to pipes are asynchronous; a bare
 * process.exit() right after can truncate the message (the test
 * harness spawns us with piped stdio). Drain first, then exit.
 */
function exitAfterFlush(code) {
  process.stdout.write("", () =>
    process.stderr.write("", () => process.exit(code)),
  );
  throw new Fatal(`exit(${code})`);
}

function die(msg, code = 2) {
  process.stderr.write(`[supervisor] ${msg}\n`, () => process.exit(code));
  throw new Fatal(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------------------------
// Supervisor
// -----------------------------------------------------------------------

class Supervisor {
  constructor({ config, statePath, apiPort }) {
    this.ui = config.ui;
    this.presets = config.presets ?? {};
    this.statePath = statePath;
    this.apiPort = apiPort;
    this.apiToken = config.apiToken ?? null;
    /** desired state: [{ dir, preset, name? }] */
    this.agents = [];
    /** name → run record */
    this.running = new Map();
    /** name → crash bookkeeping */
    this.crashes = new Map();
    this.startedAt = Date.now();
    this.shuttingDown = false;
  }

  discoverPath() {
    return join(dirname(this.statePath), "supervisor.json");
  }

  loadState() {
    this.agents = readJson(this.statePath, []);
    if (!Array.isArray(this.agents)) this.agents = [];
  }

  saveState() {
    atomicWriteJson(this.statePath, this.agents);
  }

  entryKey(entry) {
    return entry.name ?? entry.preset;
  }

  /** The effective command for an entry, or null if the preset is gone. */
  commandFor(entry) {
    return this.presets[entry.preset] ?? null;
  }

  // -- Reconciliation ------------------------------------------------

  /**
   * Make reality match the state file: start desired agents that
   * aren't running, stop running agents that are no longer
   * desired. Idempotent; safe to call from every event path.
   */
  reconcile() {
    const desired = new Set(this.agents.map((e) => this.entryKey(e)));

    for (const entry of this.agents) {
      const key = this.entryKey(entry);
      if (this.running.has(key)) continue;
      const cmd = this.commandFor(entry);
      if (cmd === null) {
        // Config problem: preset deleted while entries reference
        // it. The entry stays (desired state is never silently
        // rewritten to fix config); a human fixes or removes it.
        log(`${key}: preset ${JSON.stringify(entry.preset)} missing, skipping`);
        continue;
      }
      this.startAgent(entry, cmd).catch((err) =>
        log(`${key}: failed to start: ${err.message}`),
      );
    }

    for (const [key, run] of this.running) {
      if (!desired.has(key)) {
        log(`${key}: no longer desired, stopping`);
        this.stopAgent(key, run);
      }
    }
  }

  async startAgent(entry, cmd, reason = "boot") {
    const key = this.entryKey(entry);
    if (!existsSync(entry.dir) || !statSync(entry.dir).isDirectory()) {
      log(`${key}: directory ${entry.dir} does not exist, skipping`);
      return;
    }
    const agent = await launchAgent({
      spec: cmd,
      cwd: entry.dir,
      label: key,
      onChildExit: (code, signal) => this.onChildExit(key, code, signal),
    });
    const registrar = createRegistrar({
      ui: this.ui,
      folder: entry.dir,
      agentUrl: agent.agentUrl,
      agentName: key,
    });
    // register() retries forever on its own; the supervisor
    // doesn't block convergence on the UI being reachable.
    void registrar.register().then(() => registrar.keepRegistered());
    this.running.set(key, {
      entry,
      agent,
      registrar,
      cmd,
      startedAt: Date.now(),
    });
    log(
      `${key}: started (${reason}) — ${entry.dir} bridge ${agent.agentUrl}`,
    );
  }

  onChildExit(key, code, signal) {
    const run = this.running.get(key);
    this.running.delete(key);
    if (this.shuttingDown || !run) return;
    run.registrar.stop();

    const stillDesired = this.agents.some(
      (e) => this.entryKey(e) === key,
    );
    if (!stillDesired) return;

    const c = this.crashes.get(key) ?? { count: 0, backoff: RESTART_BACKOFF_START_MS };
    // Long-lived children reset their crash counter: a crash after
    // an hour of work is a different event than a crash loop.
    if (Date.now() - run.startedAt > UPTIME_RESET_MS) {
      c.count = 0;
      c.backoff = RESTART_BACKOFF_START_MS;
    }
    c.count += 1;
    this.crashes.set(key, c);
    log(`${key}: exited code=${code} signal=${signal} (crash ${c.count})`);

    if (c.count >= CRASHES_BEFORE_ERRORED) {
      log(
        `${key}: ${c.count} consecutive crashes — marked errored; ` +
          `fix the preset and touch the state file, or rm the entry`,
      );
      return;
    }

    const delay = c.backoff;
    c.backoff = Math.min(RESTART_BACKOFF_CAP_MS, c.backoff * 2);
    setTimeout(() => {
      if (this.shuttingDown) return;
      const entry = this.agents.find((e) => this.entryKey(e) === key);
      const cmd = entry && this.commandFor(entry);
      if (!entry || cmd === null) return;
      this.startAgent(entry, cmd, `restart after ${delay}ms backoff`).catch(
        (err) => log(`${key}: failed to restart: ${err.message}`),
      );
    }, delay);
  }

  async stopAgent(key, run) {
    run.registrar?.stop();
    try {
      await run.registrar?.unregister();
    } catch {}
    run.agent?.stop();
    this.running.delete(key);
    this.crashes.delete(key);
  }

  async shutdown() {
    this.shuttingDown = true;
    for (const [key, run] of this.running) {
      log(`${key}: stopping`);
      await this.stopAgent(key, run);
    }
    try {
      unlinkSync(this.discoverPath());
    } catch {}
  }

  // -- State file events ----------------------------------------------

  /** Re-read the state file and converge. Tolerates hand edits. */
  onStateChange() {
    this.loadState();
    this.reconcile();
  }

  watchFiles() {
    try {
      watch(dirname(this.statePath), (event, filename) => {
        if (filename !== basename(this.statePath)) return;
        // Atomic writes rename into place; give the rename a beat.
        setTimeout(() => this.onStateChange(), 50);
      });
    } catch {}
    process.on("SIGHUP", () => {
      const config = readJson(this.configPath, null);
      if (config?.presets) {
        this.presets = config.presets;
        if (config.ui) this.ui = config.ui;
        log("config reloaded");
        this.reconcile();
      }
    });
  }

  // -- HTTP API ---------------------------------------------------------

  authorized(req) {
    if (!this.apiToken) return true;
    return req.headers.authorization === `Bearer ${this.apiToken}`;
  }

  startApi() {
    const server = createServer(async (req, res) => {
      const json = (code, body) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      try {
        const u = new URL(req.url, "http://localhost");
        if (u.pathname === "/health") {
          return json(200, {
            ok: true,
            uptimeMs: Date.now() - this.startedAt,
            agents: this.running.size,
          });
        }
        if (!this.authorized(req)) return json(401, { error: "unauthorized" });

        if (req.method === "GET" && u.pathname === "/agents") {
          return json(200, {
            agents: this.agents.map((entry) => {
              const key = this.entryKey(entry);
              const run = this.running.get(key);
              const crashes = this.crashes.get(key);
              return {
                name: key,
                dir: entry.dir,
                preset: entry.preset,
                status: run
                  ? "running"
                  : crashes
                    ? "errored"
                    : "stopped",
                agentUrl: run?.agent.agentUrl ?? null,
                crashes: crashes?.count ?? 0,
              };
            }),
          });
        }
        if (req.method === "GET" && u.pathname === "/presets") {
          return json(200, { presets: this.presets });
        }
        if (req.method === "POST" && u.pathname === "/agents") {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const dir = typeof body.dir === "string" ? body.dir : null;
          const preset = typeof body.preset === "string" ? body.preset : null;
          if (!dir || !preset) {
            return json(400, { error: "Both 'dir' and 'preset' are required" });
          }
          if (!(preset in this.presets)) {
            return json(400, {
              error: `Unknown preset ${JSON.stringify(preset)}`,
              available: Object.keys(this.presets),
            });
          }
          if (!existsSync(dir) || !statSync(dir).isDirectory()) {
            return json(400, { error: `Not a directory: ${dir}` });
          }
          // Unnamed adds get a generated identity (<preset>-<hex6>),
          // PERSISTED in the state file: identity must be stable
          // across boots (generating per-boot would orphan the
          // Voir agent on every restart). Generated once, at add
          // time — hand-written state entries without a name keep
          // the preset as their identity.
          const name =
            typeof body.name === "string" && body.name.trim()
              ? body.name.trim()
              : randomName(preset);
          const entry = { dir, preset, name };
          const key = this.entryKey(entry);
          if (this.agents.some((e) => this.entryKey(e) === key)) {
            return json(409, { error: `Agent ${JSON.stringify(key)} already exists` });
          }
          this.agents.push(entry);
          this.saveState();
          this.reconcile();
          return json(201, { name: key });
        }
        const rmMatch = u.pathname.match(/^\/agents\/([^/]+)$/);
        if (req.method === "DELETE" && rmMatch) {
          const key = decodeURIComponent(rmMatch[1]);
          const idx = this.agents.findIndex(
            (e) => this.entryKey(e) === key || e.dir === key,
          );
          if (idx === -1) return json(404, { error: `No agent ${JSON.stringify(key)}` });
          this.agents.splice(idx, 1);
          this.saveState();
          this.reconcile();
          return json(200, { removed: key });
        }
        return json(404, { error: "not found" });
      } catch (err) {
        return json(500, { error: String(err?.message ?? err) });
      }
    });
    return new Promise((resolve, reject) => {
      // Reject on listen errors (EADDRINUSE …) instead of letting
      // the process die with an unhandled event — the caller
      // gets to die with a message instead.
      server.once("error", reject);
      server.listen(this.apiPort, "127.0.0.1", () => resolve(server));
    });
  }

  async run() {
    this.configPath = this.configPathArg;
    this.loadState();
    // The discovery file always lives next to the state file as
    // "supervisor.json"; a config path that collides with it
    // would be overwritten on boot. Refuse rather than clobber.
    if (this.configPath === this.discoverPath()) {
      die(
        `config path must not be the supervisor's own discovery file ` +
          `(${this.discoverPath()}); pick a different --config`,
      );
    }
    // Listen BEFORE writing the discovery file: a boot that
    // dies on the port must not leave a discovery record
    // claiming a daemon that never came up (it poisons the CLI's
    // "find a running daemon" lookup).
    try {
      this.apiServer = await this.startApi();
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? err.code : null;
      die(
        `cannot listen on 127.0.0.1:${this.apiPort}: ` +
          (code === "EADDRINUSE"
            ? "port in use — is another voir-supervisor already running?"
            : (err && err.message) || String(err)),
        1,
      );
    }
    // Any exit path — crash included — must not leave a stale
    // discovery file behind.
    process.on("exit", () => {
      try {
        unlinkSync(this.discoverPath());
      } catch {}
    });
    atomicWriteJson(this.discoverPath(), {
      pid: process.pid,
      port: this.apiPort,
      startedAt: this.startedAt,
    });
    log(
      `api on http://127.0.0.1:${this.apiPort}` +
        (this.apiToken ? " (token required)" : ""),
    );
    log(`state: ${this.statePath} (${this.agents.length} desired)`);
    this.watchFiles();
    this.reconcile();
    const tick = setInterval(() => this.reconcile(), REREGISTER_INTERVAL_MS);
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, async () => {
        clearInterval(tick);
        await this.shutdown();
        this.apiServer?.close();
        this.apiServer?.closeAllConnections?.();
        exitAfterFlush(0);
      });
    }
  }
}

// -----------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------

async function findDaemon(statePath) {
  const disc = readJson(
    join(dirname(statePath), "supervisor.json"),
    null,
  );
  if (!disc || typeof disc.port !== "number") return null;
  // Trust a responding /health over the recorded pid: a stale
  // discovery file (a twin that died on the port) must not hide
  // a healthy daemon that happens to listen on the same port.
  // The health endpoint's shape is the daemon's own.
  try {
    const res = await fetch(`http://127.0.0.1:${disc.port}/health`);
    if (!res.ok) return null;
    const health = await res.json();
    if (!health || health.ok !== true) return null;
    return { port: disc.port, health, token: null };
  } catch {
    return null;
  }
}

function defaultPaths(flags) {
  const config =
    flags.config ??
    join(homedir(), ".config", "voir", "supervisor.json");
  const state =
    flags.state ??
    join(homedir(), ".local", "state", "voir", "agents.json");
  return { config, state };
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") flags.config = argv[++i];
    else if (a === "--state") flags.state = argv[++i];
    else if (a === "--preset") flags.preset = argv[++i];
    else if (a === "--name") flags.name = argv[++i];
    else if (a === "--api-port") flags.apiPort = Number(argv[++i]);
    else if (a === "-h" || a === "--help") {
      printHelp();
      exitAfterFlush(0);
    } else positional.push(a);
  }
  return { flags, positional };
}

function printHelp() {
  console.log(`Usage: voir-supervisor <command> [options]

Commands:
  run                    run the daemon (default when no command given)
  add <dir> --preset <p> [--name <n>]   launch an agent in <dir> and
                                        persist it in the state file
  rm <name|dir>          stop the agent and remove it from state
  ls                     list desired + running agents

Options:
  --config <path>   config file (presets + ui)
                    [default: ~/.config/voir/supervisor.json]
  --state <path>    desired-state file, written by the supervisor
                    [default: ~/.local/state/voir/agents.json]
  --api-port <n>    daemon HTTP API port [default: ${DEFAULT_API_PORT}]

Config file (authored by you, read by the daemon):
  {
    "ui": "https://chat.lab",
    "presets": { "pi": "pi-acp",
                 "pi-fenced": "fence exec --private . -- pi-acp" }
  }

The state file is desired state — what SHOULD be running. The
supervisor writes it atomically on add/rm and converges to it on
boot, crash, and every change (hand edits included).`);
}

async function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2));
  const [cmd] = positional;
  const paths = defaultPaths(flags);

  if (!cmd || cmd === "run") {
    const config = readJson(paths.config, null);
    if (!config || !config.ui) {
      die(
        `missing or invalid config at ${paths.config} — create it with at least ` +
          `{"ui": "…", "presets": {…}} (see --help)`,
      );
    }
    const sup = new Supervisor({
      config,
      statePath: paths.state,
      apiPort: flags.apiPort ?? DEFAULT_API_PORT,
    });
    sup.configPathArg = paths.config;
    await sup.run();
    return;
  }

  if (cmd === "add") {
    const dir = positional[1];
    if (!dir || !flags.preset) die("usage: add <dir> --preset <p> [--name <n>]");
    const daemon = await findDaemon(paths.state);
    if (daemon) {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(daemon.token ? { Authorization: `Bearer ${daemon.token}` } : {}),
        },
        body: JSON.stringify({
          dir: dir.replace(/~\/?/, homedir()),
          preset: flags.preset,
          ...(flags.name ? { name: flags.name } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) die(body.error ?? `add failed (${res.status})`, 1);
      console.log(`added ${body.name} — supervisor is starting it`);
      return;
    }
    // Daemon not running: edit the desired state directly. The
    // supervisor will converge on its next boot.
    const config = readJson(paths.config, null);
    if (config?.presets && !(flags.preset in config.presets)) {
      die(`unknown preset ${JSON.stringify(flags.preset)}`, 1);
    }
    const agents = readJson(paths.state, []);
    if (!Array.isArray(agents)) die(`invalid state file at ${paths.state}`, 1);
    // Same rule as the API: unnamed adds get a generated identity,
    // persisted so it survives boots.
    agents.push({
      dir: dir.replace(/~\/?/, homedir()),
      preset: flags.preset,
      name: flags.name ?? randomName(flags.preset),
    });
    atomicWriteJson(paths.state, agents);
    console.log(
      `added to ${paths.state} — supervisor not running; it will start on next boot`,
    );
    return;
  }

  if (cmd === "rm") {
    const key = positional[1];
    if (!key) die("usage: rm <name|dir>");
    const daemon = await findDaemon(paths.state);
    if (daemon) {
      const res = await fetch(
        `http://127.0.0.1:${daemon.port}/agents/${encodeURIComponent(key)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        die(body.error ?? `rm failed (${res.status})`, 1);
      }
      console.log(`removed ${key}`);
      return;
    }
    const agents = readJson(paths.state, []);
    if (!Array.isArray(agents)) die(`invalid state file at ${paths.state}`, 1);
    const kept = agents.filter(
      (e) => (e.name ?? e.preset) !== key && e.dir !== key,
    );
    atomicWriteJson(paths.state, kept);
    console.log(
      `removed from ${paths.state} — supervisor not running; it will converge on next boot`,
    );
    return;
  }

  if (cmd === "ls") {
    const daemon = await findDaemon(paths.state);
    if (daemon) {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/agents`);
      const body = await res.json();
      for (const a of body.agents) {
        console.log(
          `${a.status === "running" ? "▶" : a.status === "errored" ? "✗" : "·"} ` +
            `${a.name.padEnd(16)} ${a.preset.padEnd(12)} ${a.dir}` +
            (a.crashes > 0 ? `  (crashes: ${a.crashes})` : ""),
        );
      }
      return;
    }
    const agents = readJson(paths.state, []);
    console.log("supervisor not running; desired state:");
    for (const e of agents) {
      console.log(`· ${(e.name ?? e.preset).padEnd(16)} ${e.preset.padEnd(12)} ${e.dir}`);
    }
    return;
  }

  die(`unknown command ${JSON.stringify(cmd)} (see --help)`);
}

main().catch((err) => {
  // die()/exitAfterFlush() already scheduled the exit; a Fatal
  // unwinding to here is the halt, not a failure to report.
  if (err instanceof Fatal) return;
  die(err?.message ?? String(err), 1);
});