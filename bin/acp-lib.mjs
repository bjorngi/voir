// acp-lib — the reusable core of the acp-spawn launcher.
//
// Everything here is process plumbing shared by the one-shot
// launcher (bin/acp-spawn.mjs) and the resident supervisor
// (bin/voir-supervisor.mjs):
//
//   launchAgent()      spawn an agent child + expose it as an
//                      ACP JSON-RPC 2.0 HTTP endpoint (the bridge)
//   createRegistrar()  register the bridge with a Voir instance,
//                      keep re-registering (so a Voir restart
//                      self-heals), unregister on shutdown
//
// The bridge shape (see docs/sandbox.md):
//   POST <url>  one JSON-RPC message per request body
//               200 + JSON-RPC response (requests)
//               204 (notifications)
//               204/503 for the local `ping` health probe
//   GET  <url>  text/event-stream, one JSON-RPC message per
//               `data:` line (flushed immediately, so a
//               reconnecting client's fetch resolves right away)
//
// Nothing in this file knows about presets, state files or
// supervision policy — those live in the callers.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";

// -----------------------------------------------------------------------
// Ports and URLs
// -----------------------------------------------------------------------

/** Pick a free TCP port on loopback. */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * The URL the UI will call the bridge under. Depends on whether
 * the launcher and the UI share a network namespace:
 *   - on-host: bind=127.0.0.1, no --url → http://127.0.0.1:<port>/
 *   - container: bind=0.0.0.0 + url=http://<svc>:<port>/ (the UI
 *     reaches the agent under a compose service name)
 * Throws on an unsupported protocol or malformed URL.
 */
export function resolveAgentUrl({ bind, port, url }) {
  if (url) {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`unsupported protocol: ${u.protocol}`);
    }
    const full = u.toString();
    return full.endsWith("/") ? full : full + "/";
  }
  return `http://${bind}:${port}/`;
}

// -----------------------------------------------------------------------
// Agent + bridge
// -----------------------------------------------------------------------

/**
 * Spawn an agent child speaking ACP JSON-RPC over stdio and
 * expose it as the HTTP bridge described in the header.
 *
 * `spec` is a command + args split on whitespace:
 *   "pi-acp"  |  "fence exec --private . -- pi-acp"
 * A single token is just the command; paths with spaces inside
 * one argument aren't supported — wrap them in a script.
 *
 * `onChildExit(code, signal)` fires when the child dies on its
 * own (not via stop()). The launcher treats that as fatal; the
 * supervisor treats it as "restart me".
 *
 * Returns { child, server, port, agentUrl, stop() }. stop() is
 * idempotent and does NOT wait for the child to acknowledge.
 */
export async function launchAgent({
  spec,
  cwd,
  bind = "127.0.0.1",
  port = null,
  url = null,
  sseLifetime = null,
  label = null,
  env = {},
  onChildExit = null,
}) {
  const folder = cwd;
  const agentSpec = String(spec).trim().split(/\s+/).filter(Boolean);
  if (agentSpec.length === 0) throw new Error("empty agent spec");
  const [agentCmd, ...agentArgs] = agentSpec;
  const tag = label ?? agentSpec[0];

  let stopped = false;
  const child = spawn(agentCmd, agentArgs, {
    cwd: folder,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ACP_FOLDER: folder, ...env },
  });
  child.stderr.on("data", (b) => process.stderr.write(`[${tag}] ${b}`));
  child.on("error", (err) => {
    if (stopped) return;
    process.stderr.write(
      `[${tag}] failed to start: ${err.message}\n` +
        `[${tag}] hint: is the agent on PATH? try \`command -v ${agentCmd}\`\n`,
    );
  });
  child.on("exit", (code, signal) => {
    if (stopped) return; // our own stop(); no event
    onChildExit?.(code, signal);
  });

  // JSON-RPC framing on stdout → request responses + SSE push
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

  const actualPort = port ?? (await findFreePort());
  const agentUrl = resolveAgentUrl({ bind, port: actualPort, url });

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        // Transport-level health probe. `ping` is not an ACP
        // method — it's the heartbeat the UI sends every 10s.
        // Answer it here instead of forwarding it into the
        // agent: forwarded as a JSON-RPC notification it was
        // fire-and-forget (204 came back regardless of the
        // child's state), and agents that don't implement the
        // method (pi-acp) logged -32601 spam on every
        // heartbeat. Liveness here = bridge up AND child alive.
        if (body.method === "ping" && body.id === undefined) {
          const alive = child.exitCode === null && !stopped;
          res.statusCode = alive ? 204 : 503;
          res.end();
          return;
        }
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
        // Flush the response head immediately: Node buffers
        // headers until the first write/end otherwise, so an SSE
        // client's fetch (and thus its reconnect detection)
        // wouldn't resolve until the agent happens to push its
        // first notification. For a client that just reconnected
        // after a drop, that can be a full keep-alive interval
        // of dead time.
        res.flushHeaders();
        sseClients.add(res);
        const ka = setInterval(() => {
          try {
            res.write(": ka\n\n");
          } catch {}
        }, 15_000);
        // Test aid: forcibly end the stream after a lifetime,
        // simulating a proxy timeout / network drop.
        let lifetime = null;
        if (sseLifetime && sseLifetime > 0) {
          lifetime = setTimeout(() => {
            try {
              res.end();
            } catch {}
          }, sseLifetime);
        }
        req.on("close", () => {
          clearInterval(ka);
          if (lifetime) clearTimeout(lifetime);
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

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(actualPort, bind, resolve);
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    server.close();
    server.closeAllConnections?.();
    child.kill("SIGTERM");
  };

  return { child, server, port: actualPort, agentUrl, stop };
}

// -----------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------

const REREGISTER_INTERVAL_MS = 30_000;

/**
 * Owns one bridge's relationship with the UI:
 *
 *   await register()    initial registration, retried with a 10s
 *                       backoff until it lands (the UI may be
 *                       restarting). Resolves once registered.
 *   keepRegistered()    re-POST every 30s so a UI restart
 *                       self-heals (the UI keeps all state in
 *                       memory; the registration is the only
 *                       thing that went missing).
 *   async unregister()   best-effort DELETE on shutdown.
 *   stop()              stop the keep-alive loop (unregister is
 *                       still safe afterwards).
 *
 * State transitions are logged; routine re-registrations are not.
 */
export function createRegistrar({ ui, folder, agentUrl, agentName }) {
  let registered = false;
  let stopping = false;
  let timer = null;

  const post = async () => {
    const res = await fetch(`${ui}/api/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: folder, agentUrl, agentName }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${text}`);
    }
    return res.json();
  };

  const register = async () => {
    for (;;) {
      try {
        const body = await post();
        registered = true;
        const browse = `${ui.replace(/\/$/, "")}${body.browse}`;
        console.log(`registered → browse: ${browse}`);
        return body;
      } catch (err) {
        if (stopping) return null;
        console.error(
          `failed to register with ${ui} (${err.message}) — retrying in 10s`,
        );
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  };

  const keepRegistered = () => {
    if (timer) return;
    timer = setInterval(() => {
      if (stopping || !registered) return;
      post()
        .then(() => {
          if (!registered) {
            registered = true;
            console.log(`re-registered with ${ui}`);
          }
        })
        .catch((err) => {
          if (registered) {
            registered = false;
            console.error(
              `lost registration with ${ui} (${err.message}) — will retry`,
            );
          }
        });
    }, REREGISTER_INTERVAL_MS);
  };

  const unregister = async () => {
    try {
      const url = `${ui}/api/folders?path=${encodeURIComponent(folder)}` +
        (agentName ? `&name=${encodeURIComponent(agentName)}` : "");
      await fetch(url, { method: "DELETE" });
    } catch {}
  };

  const stop = () => {
    stopping = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  return { register, keepRegistered, unregister, stop };
}