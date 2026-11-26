#!/usr/bin/env node
// dev — one command to run the whole Voir dev stack with mock
// agents, no docker, no API keys:
//
//   npm run dev:mock
//
// What it starts:
//
//   web      the react-router dev server (vite, live reload)
//            on 127.0.0.1:<port>        (default 9000)
//   mock-a   acp-spawn + mock-acp on ./dev-data/project-a
//   mock-b   acp-spawn + mock-acp on ./dev-data/project-b
//
// The two mocks are the same binary (bin/mock-acp.mjs) with
// different MOCK_VARIANT seed sets, so the sidebar shows two
// folders that look lived-in and DIFFERENT — that variety is
// the point: this stack is the backdrop for UI work (redesign,
// screenshots, e2e walkthroughs), and it should exercise every
// renderable thing without an agent binary or a network.
//
// Isolation from the real stack: VOIR_DATA_DIR is pointed at
// dev-data/runtime BEFORE any child is spawned, so the dev
// server's durable state (session-status overlay, push
// subscriptions, uploads, search index) never touches the
// production data dir that `bin/server.ts` uses. The runtime
// dir gets a fresh session-status preseed on first boot (one
// archived + two active seed sessions) so the "Working on"
// shortlist and the "Show archived" affordance have something
// to show immediately.
//
// Flags:
//   --port <n>     web port (default 9000; bridges pick free ports)
//   --no-web       only start the mock bridges (you run vite yourself)
//   --no-mocks     only start the web server
//   --fresh        wipe the runtime state dir first (session-status
//                  overlay, uploads, search index) so the stack boots
//                  from the seeded baseline — used by test:e2e, where
//                  the archive/status tests must start from a known
//                  state on every run
//   -h, --help
//
// Ctrl-C (SIGINT/SIGTERM) tears it all down: acp-spawn children
// unregister their folders on the way out, so the UI (if it's
// still up) drops them cleanly.

import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── args ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { port: 9000, web: true, mocks: true, fresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--no-web") opts.web = false;
    else if (a === "--no-mocks") opts.mocks = false;
    else if (a === "--fresh") opts.fresh = true;
    else if (a === "-h" || a === "--help") {
      console.log(`Usage: node bin/dev.mjs [--port <n>] [--no-web] [--no-mocks] [--fresh]

Starts the Voir dev server plus two mock ACP agents (project-a,
project-b) pre-seeded with distinct session sets. VOIR_DATA_DIR
is isolated to dev-data/runtime so nothing touches production
state. --fresh resets that state first. See the header of
bin/dev.mjs for details.`);
      process.exit(0);
    } else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// ── data dir isolation + status preseed ──────────────────────────────
// Must happen before any child is spawned: children inherit env,
// and the vite child's server modules read VOIR_DATA_DIR lazily.
// An explicitly provided VOIR_DATA_DIR wins (the e2e suite points it
// at a throwaway dir); otherwise the dev stack gets its own corner of
// dev-data/ so it never scribbles on the real store bin/server.ts uses.
const DATA_DIR = process.env.VOIR_DATA_DIR ?? join(ROOT, "dev-data", "runtime");
process.env.VOIR_DATA_DIR = DATA_DIR;
if (opts.fresh && existsSync(DATA_DIR)) {
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`[dev] --fresh: wiped ${DATA_DIR}`);
}
mkdirSync(DATA_DIR, { recursive: true });

// Keep the mock stack off the estate's real telemetry. The
// repo .env points faro + OTel at the production collector
// stack; a mock run has no business shipping spans/beacons
// there (and the browser console fills with CORS errors from
// the blocked beacon). Empty string, not "false": these are
// read as strings (faro.ts: `if (!import.meta.env…)`), where
// "false" is still truthy.
process.env.VITE_FARO_ENABLED = "";
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "";
process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "";

function preseedSessionStatus() {
  const file = join(DATA_DIR, "session-status.json");
  if (existsSync(file)) return; // runtime state survives restarts
  const projectA = join(ROOT, "dev-data", "project-a");
  const projectB = join(ROOT, "dev-data", "project-b");
  const at = Date.now();
  // Seed ids are variant-namespaced (see bin/mock-acp.mjs —
  // seed ids must stay unique across the two mock agents).
  // One archived row exercises the "Show archived" reveal; two
  // active rows give the "Working on" shortlist content on
  // first paint.
  writeFileSync(
    file,
    JSON.stringify(
      {
        version: 1,
        folders: {
          [projectA]: {
            "seed-a-rich-content-tour": { status: "active", at },
            "seed-a-add-a-health-endpoint": { status: "archived", at },
          },
          [projectB]: {
            "seed-b-what-is-voir": { status: "active", at },
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`[dev] preseeded session-status.json (1 archived, 2 active)`);
}
preseedSessionStatus();

// ── process management ───────────────────────────────────────────────
const children = [];
let shuttingDown = false;

function start(name, cmd, args, cwd, extraEnv = {}) {
  const child = spawn(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  console.log(`[dev] ${name} started (pid ${child.pid})`);
  // Any child dying unexpectedly takes the stack with it — half
  // a stack is a confusing debug session, better to exit loud.
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev] ${name} exited (code=${code} signal=${signal}) — shutting down`);
    shutdown(code ?? 1);
  });
  return child;
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  // SIGTERM, not SIGKILL: acp-spawn unregisters its folder on
  // the way out, and vite flushes its caches. Give them a
  // moment, then take the process down.
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {}
  }
  setTimeout(() => process.exit(code), 500);
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => shutdown(0));
}

// ── web server ───────────────────────────────────────────────────────
async function waitFor(what, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function apiFolders() {
  const res = await fetch(`http://127.0.0.1:${opts.port}/api/folders`);
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()).folders ?? [];
}

if (opts.web) {
  // --strictPort: if the port is busy we want a loud failure,
  // not a silent drift to 9001 (the tests pin a port and the
  // user pinned a bookmark).
  start(
    "web",
    "npm",
    ["run", "dev", "--", "--port", String(opts.port), "--strictPort"],
    ROOT,
  );
  const t0 = Date.now();
  await waitFor("web server", async () => {
    try {
      await apiFolders();
      return true;
    } catch {
      return false;
    }
  }, 120_000);
  console.log(`[dev] web up on http://127.0.0.1:${opts.port} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// ── mock bridges ─────────────────────────────────────────────────────
const MOCKS = [
  {
    name: "mock-a",
    dir: "project-a",
    variant: "a",
    // Fixture-git target files: one for a committed change on the
    // demo branch, one left dirty (the "work in progress" the
    // Changes tab is there to show).
    code: "src/util.ts",
    dirty: "NOTES.md",
  },
  {
    name: "mock-b",
    dir: "project-b",
    variant: "b",
    code: "src/parse.ts",
    dirty: "EXPERIMENT.md",
  },
];

/**
 * Make the sample worktree a real git repository with a base branch,
 * a feature branch and an uncommitted edit — exactly the shape the
 * Changes tab and the folder row's ±pill read.
 *
 * Without this the Changes view renders "Not a git repository" on
 * every display and a redesign review has no diff to look at, which
 * is a hole: diffs are the most aspect-ratio-sensitive screen in the
 * app (side-by-side hunks, long lines, no wrap by default).
 *
 * The repos are created at runtime and never committed: .gitignore
 * excludes dev-data/<project>/.git so the voir checkout stays a
 * single repository. Missing git (containers) is a soft failure —
 * the rest of the stack doesn't depend on it.
 */
function ensureFixtureGit(fixture) {
  const dir = join(ROOT, "dev-data", fixture.dir);
  if (existsSync(join(dir, ".git"))) return;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "voir fixture",
    GIT_AUTHOR_EMAIL: "fixture@voir.invalid",
    GIT_COMMITTER_NAME: "voir fixture",
    GIT_COMMITTER_EMAIL: "fixture@voir.invalid",
  };
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore", env });
  try {
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture: import sample worktree");
    // A feature branch with one committed change…
    git("checkout", "-q", "-b", "feat/mock-work");
    appendFileSync(
      join(dir, fixture.code),
      "\n// fixture: added on the mock work branch so the Changes tab\n" +
        "// has a committed hunk to render next to the dirty one.\n" +
        "export function fixtureMarker(): string {\n  return \"mock work\";\n}\n",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "feat: add fixture marker");
    // …and an uncommitted edit beside it.
    appendFileSync(
      join(dir, fixture.dirty),
      "\n<!-- fixture: uncommitted work in progress -->\n" +
        "TODO: tighten this up before the demo (not committed on purpose).\n",
    );
    console.log(`[dev] prepared git fixture in ${fixture.dir} (feat/mock-work + dirty tree)`);
  } catch (err) {
    console.warn(
      `[dev] could not prepare git fixture in ${fixture.dir}: ${err.message} — Changes tab will be empty`,
    );
  }
}

if (opts.mocks) {
  for (const m of MOCKS) ensureFixtureGit(m);
  for (const m of MOCKS) {
    const cwd = join(ROOT, "dev-data", m.dir);
    start(
      m.name,
      process.execPath,
      [
        join(ROOT, "bin", "acp-spawn.mjs"),
        "--agent",
        `node ${join(ROOT, "bin", "mock-acp.mjs")}`,
        "--name",
        m.name,
        "--ui",
        `http://127.0.0.1:${opts.port}`,
        // No --port: acp-spawn picks a free one, so several dev
        // stacks (interactive + e2e) can run side by side.
      ],
      cwd,
      // MOCK_VARIANT reaches the mock child through acp-spawn's
      // inherited env — per-spawn, so each bridge gets its own.
      { MOCK_VARIANT: m.variant },
    );
  }

  // Wait until both folders are registered, then say so.
  const wanted = MOCKS.map((m) => join(ROOT, "dev-data", m.dir));
  await waitFor("mock agents to register", async () => {
    const folders = await apiFolders().catch(() => []);
    return wanted.every((p) => folders.some((f) => f.path === p));
  }, 30_000);
  console.log(`[dev] mock-a + mock-b registered (variants a/b)`);
}

console.log(`\n[dev] ▶ open http://127.0.0.1:${opts.port} — Ctrl-C to tear down\n`);
