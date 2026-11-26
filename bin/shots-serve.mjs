#!/usr/bin/env node
// shots-serve — serve a screenshot gallery on your tailnet so you
// can review visual changes from your phone or laptop.
//
//   npm run shots:serve                  latest run, port 9310
//   npm run shots:serve -- --port 9311
//   npm run shots:serve -- --dir shots/2026-11-26_18-20-00
//
// Binds the Tailscale IPv4 (100.64.0.0/10) ONLY — same policy as
// the dev server's tailscaleProxy: reachable from your tailnet,
// never from LAN/WAN. Falls back to loopback with a warning when
// no tailnet interface is present.
//
// For a secure-context HTTPS URL (needed if you want service
// workers / the microphone on a phone — not for screenshots), the
// printed hint uses `tailscale serve`, which fronts this port with
// a MagicDNS certificate.
//
// Path handling is strictly inside the chosen gallery dir: the
// server only ever resolves within it (traversal attempts 404).

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── args ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { port: 9310, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--dir") opts.dir = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log(`Usage: node bin/shots-serve.mjs [--dir <path>] [--port <n>]

Serves a screenshot gallery on the tailnet (default: the newest
run under shots/, port 9310).`);
      process.exit(0);
    } else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// ── newest run when --dir is omitted ─────────────────────────────────
function latestRun() {
  const base = join(ROOT, "shots");
  if (!existsSync(base)) return null;
  const runs = readdirSync(base)
    .map((name) => join(base, name))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "index.html")))
    .sort((a, b) => a.localeCompare(b));
  return runs.at(-1) ?? null;
}

const dir = resolve(opts.dir ?? latestRun() ?? "");
if (!opts.dir && !dir) {
  console.error(
    "[shots:serve] no gallery found under shots/ — run `npm run shots` first " +
      "(with the mock stack up), or pass --dir <path>.",
  );
  process.exit(1);
}
if (!existsSync(join(dir, "index.html"))) {
  console.error(`[shots:serve] ${dir} has no index.html — is that a shots run dir?`);
  process.exit(1);
}

// ── tailnet detection (same rule as vite.config.ts) ──────────────────
function tailscaleIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal || String(a.family) !== "IPv4") continue;
      const m = /^100\.(\d+)\./.exec(a.address);
      if (!m) continue;
      const second = Number(m[1]);
      if (second >= 64 && second <= 127) return a.address;
    }
  }
  return null;
}

// ── static file server ───────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(handler);

function handler(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  // normalize() collapses .. before we join, then we assert the
  // result is still inside the gallery root.
  const file = normalize(join(dir, rel));
  if (file !== dir && !file.startsWith(dir + sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  let st;
  try {
    st = statSync(file);
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  if (st.isDirectory()) {
    res.writeHead(302, { Location: rel.replace(/\/?$/, "/") + "index.html" }).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": st.size,
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(res);
}

// Two listeners, one handler: loopback for this machine (curl,
// the e2e/dev tooling) and the Tailscale interface for phones and
// other tailnet devices. Never LAN/WAN — same policy as the vite
// tailscaleProxy in vite.config.ts.
const host = tailscaleIPv4();
const listen = (bind) =>
  new Promise((ok) => {
    const s = bind === host || !host ? server : createServer(handler);
    s.listen(opts.port, bind, () => ok());
  });

await listen("127.0.0.1");
if (host) await listen(host);

const base = `http://${host ?? "127.0.0.1"}:${opts.port}/`;
console.log(`[shots:serve] ${dir}`);
console.log(`[shots:serve] local    →  http://127.0.0.1:${opts.port}/`);
if (host) {
  console.log(`[shots:serve] tailnet  →  ${base}`);
  console.log(
    `[shots:serve] https    →  tailscale serve --bg ${opts.port}   ` +
      "(then https://<host>.<tailnet>.ts.net/)",
  );
} else {
  console.log("[shots:serve] no Tailscale interface found — loopback only.");
}
