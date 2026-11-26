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
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
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

// ── generated worktrees ───────────────────────────────────────────────
// The tracked sample worktrees under dev-data/ stay PRISTINE: they are
// the source material, and a dev run must not dirty the checkout (the
// fixture writes files, renames one, deletes one). Each run copies them
// into dev-data/worktrees/ and builds the fixture git repo there, so
// `git status` in the repo stays clean and --fresh can always rebuild
// from the untracked source of truth.
const WORKTREES = join(ROOT, "dev-data", "worktrees");

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
if (opts.fresh && existsSync(WORKTREES)) {
  // Worktrees are derived from the pristine samples: a generator change
  // must be picked up, and every test run must see the same fixture diff.
  rmSync(WORKTREES, { recursive: true, force: true });
  console.log(`[dev] --fresh: wiped ${WORKTREES}`);
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

function materializeWorktree(fixture) {
  const src = join(ROOT, "dev-data", fixture.dir);
  const dst = join(WORKTREES, fixture.dir);
  if (existsSync(dst)) return dst;
  cpSync(src, dst, {
    recursive: true,
    filter: (path) => !path.split(/[\\/]/).includes(".git"),
  });
  return dst;
}

function preseedSessionStatus() {
  const file = join(DATA_DIR, "session-status.json");
  if (existsSync(file)) return; // runtime state survives restarts
  const projectA = join(WORKTREES, "project-a");
  const projectB = join(WORKTREES, "project-b");
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
    // Fixture-git shape (see ensureFixtureGit): every change-status
    // the diff view can render, at a size worth scrolling.
    code: "src/util.ts",
    entry: "src/main.ts",
    task: "TASKS.md",
    dirty: ["NOTES.md", "README.md"],
  },
  {
    name: "mock-b",
    dir: "project-b",
    variant: "b",
    code: "src/parse.ts",
    entry: "src/cli.ts",
    task: "EXPERIMENT.md",
    dirty: ["IDEAS.md", "README.md"],
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
/** Names of the generated service modules (fixture content only). */
const SERVICE_NAMES = [
  "accounts",
  "invoices",
  "sessions",
  "webhooks",
  "reports",
  "projects",
  "labels",
  "exports",
];

/** One plausible ~40-line module, deterministic per index. */
function serviceSource(name, index) {
  const T = name[0].toUpperCase() + name.slice(1);
  const plural = `${name} records`;
  return `// src/services/${name}.ts — sample worktree content (voir dev stack)
import { logger } from "../util";

export interface ${T}Record {
  id: string;
  name: string;
  updatedAt: string;
  /** Optimistic-concurrency token; bumped on every write. */
  revision: number;
}

/** Normalise a ${name} record coming off the wire. */
export function normalize${T}(input: Partial<${T}Record>): ${T}Record {
  return {
    id: input.id ?? "",
    name: input.name ?? "(unnamed)",
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    revision: input.revision ?? 0,
  };
}

/** Write ${plural}, skipping malformed ones. Returns how many landed. */
export async function sync${T}(records: ${T}Record[]): Promise<number> {
  let written = 0;
  for (const record of records) {
    if (!record.id) {
      logger.warn("skipping ${name} record without id", { index: ${index} });
      continue;
    }
    await persist${T}(record);
    written += 1;
  }
  logger.info("synced ${name}", { written, total: records.length });
  return written;
}

async function persist${T}(record: ${T}Record): Promise<void> {
  // …storage adapter goes here (fixture: intentionally a stub).
  void record;
}
`;
}

/** A deliberately over-long line: the diff view's "WRAP OFF" exists
 *  for exactly this, and a review at 416px needs to see it handled. */
function allowlistSource() {
  return `// src/services/allowlist.ts — sample worktree content (voir dev stack)
export const ALLOWED_HOSTS = [
  "api.internal.example", "auth.internal.example", "billing.internal.example",
];

/** One line, 240-odd characters: the kind of line that forces a
 *  horizontal scroll in an unwrapped diff pane. */
export const FALLBACK_CALLBACK_URL = "https://api.internal.example/v2/webhooks/deliver?token=00000000000000000000000000000000&retries=5&backoff=exponential&max_delay_ms=30000&signature=sha256";

export function isAllowed(host: string): boolean {
  return ALLOWED_HOSTS.includes(host);
}
`;
}

/** A file that exists on main and is deleted or renamed on the branch,
 *  so the diff view has those statuses to render — without touching the
 *  sample worktree's own files. */
function legacySource(name) {
  return `// src/legacy/${name}.ts — sample worktree content (voir dev stack)
//
// Superseded on feat/mock-work; kept on main so the diff can show a
// ${name === "report-v1" ? "deletion" : "rename"} next to the rest of the change.

export function ${name === "report-v1" ? "reportV1" : "formatLegacy"}(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
`;
}

/**
 * Make the sample worktree a real git repository whose diff matches
 * what the Changes view has to render in production: a base branch, a
 * feature branch with many files touched, every change status
 * (added / modified / deleted / renamed), hunks with context, one
 * pathologically long line, and a dirty tree on top.
 *
 * A small diff makes the diff view easy to "review" and useless to
 * review: file headers, hunk headers, wrapping and scrolling only
 * show their real behaviour at volume. This fixture is ~13 files and
 * a few hundred lines, generated deterministically so the gallery is
 * comparable between runs.
 *
 * Repos are created at runtime and never committed (.gitignore has
 * dev-data/<project>/.git). Missing git (containers) is a soft
 * failure — the rest of the stack doesn't depend on it.
 */
function ensureFixtureGit(fixture) {
  const dir = join(WORKTREES, fixture.dir);
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
  const write = (rel, body) => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  const append = (rel, body) => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    appendFileSync(abs, body);
  };
  try {
    git("init", "-q", "-b", "main");
    // Two files that only exist so the branch can delete one and rename
    // the other: every change status in the diff view, and the sample
    // worktree's own files stay untouched.
    write("src/legacy/report-v1.ts", legacySource("report-v1"));
    write("src/legacy/format.ts", legacySource("format"));
    git("add", "-A");
    git("commit", "-q", "-m", "fixture: import sample worktree");
    git("checkout", "-q", "-b", "feat/mock-work");

    // — additions: 8 generated modules + one long-line file ——
    SERVICE_NAMES.forEach((name, i) =>
      write(`src/services/${name}.ts`, serviceSource(name, i)),
    );
    write("src/services/allowlist.ts", allowlistSource());

    // — modifications with context: the existing files ——
    append(
      fixture.code,
      "\n// feat/mock-work: the fixture's first committed hunk.\n" +
        "export function fixtureMarker(): string {\n  return \"mock work\";\n}\n",
    );
    const original = readFileSync(join(dir, fixture.code), "utf8");
    write(
      fixture.code,
      "// feat/mock-work: header added so the diff has a context hunk\n" +
        "// above the function below.\n" +
        original,
    );
    append(
      fixture.entry,
      "\n// feat/mock-work: wire the generated services into the entry point.\n" +
        'import { syncAccounts } from "./services/accounts";\n' +
        'import { syncInvoices } from "./services/invoices";\n\n' +
        "export async function bootstrap(): Promise<void> {\n" +
        "  await syncAccounts([]);\n" +
        "  await syncInvoices([]);\n}\n",
    );
    append(
      fixture.task,
      "\n## feat/mock-work\n\n" +
        "- [x] scaffold the generated service modules\n" +
        "- [x] wire two of them into the entry point\n" +
        "- [ ] replace the storage stubs\n",
    );

    // — rename (git keeps history) and delete ——
    git("mv", "src/legacy/format.ts", "src/legacy/format-v2.ts");
    append(
      "src/legacy/format-v2.ts",
      "\n// Renamed on feat/mock-work: the diff renders this as a rename\n" +
        "// with a small body change.\n",
    );
    git("rm", "-q", "src/legacy/report-v1.ts");

    git("add", "-A");
    git("commit", "-q", "-m", "feat: scaffold services, wire two, tidy docs");

    // — dirty tree on top: modified files + untracked ones ——
    for (const rel of fixture.dirty) {
      append(
        rel,
        "\n<!-- uncommitted: work in progress, on purpose -->\n" +
          "TODO: tighten this up before the demo.\n",
      );
    }
    write(
      "src/queue/pending.ts",
      "// untracked: not staged yet — the diff view lists it separately.\n" +
        "export const pending: string[] = [];\n",
    );
    write(
      "src/queue/retry.ts",
      "// untracked: exponential backoff helper, still being drafted.\n" +
        "export function backoffMs(attempt: number): number {\n" +
        "  return Math.min(30_000, 2 ** attempt * 250);\n}\n",
    );

    console.log(
      `[dev] prepared git fixture in ${fixture.dir} ` +
        `(${SERVICE_NAMES.length + 5} files vs main, feat/mock-work + dirty tree)`,
    );
  } catch (err) {
    console.warn(
      `[dev] could not prepare git fixture in ${fixture.dir}: ${err.message} — Changes tab will be empty`,
    );
  }
}

if (opts.mocks) {
  for (const m of MOCKS) materializeWorktree(m);
  for (const m of MOCKS) ensureFixtureGit(m);
  for (const m of MOCKS) {
    const cwd = join(WORKTREES, m.dir);
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
  const wanted = MOCKS.map((m) => join(WORKTREES, m.dir));
  await waitFor("mock agents to register", async () => {
    const folders = await apiFolders().catch(() => []);
    return wanted.every((p) => folders.some((f) => f.path === p));
  }, 30_000);
  console.log(`[dev] mock-a + mock-b registered (variants a/b)`);
}

console.log(`\n[dev] ▶ open http://127.0.0.1:${opts.port} — Ctrl-C to tear down\n`);
