import os from "node:os";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { attachVoiceServer } from "./app/lib/voice-server";
import { attachTtsServer } from "./app/lib/tts-server";

export default defineConfig(({ mode }) => {
  // Vite only wires VITE_-prefixed vars into import.meta.env; the
  // server-side modules (voice STT providers) read process.env.
  // Load .env explicitly (real shell env wins, dotenv-style) so
  // VOICE_STT_* reach the provider factory at connection time.
  const env = loadEnv(mode, process.cwd(), "");
  for (const [k, v] of Object.entries(env)) {
    if (!(k in process.env)) process.env[k] = v;
  }
  return {
    plugins: [tailwindcss(), reactRouter(), tsconfigPaths(), tailscaleProxy()],
    server: {
      // Loopback only. Remote preview (e.g. your phone over Tailscale)
      // is handled by the tailscaleProxy plugin below — it listens on
      // the Tailscale interface specifically and forwards to this
      // loopback listener. The result is that `npm run dev` is
      // reachable from loopback + your tailnet, and NOTHING is bound
      // on LAN/WAN interfaces.
      //
      // The docker compose dev setup overrides this with
      //   --host 0.0.0.0
      // (containers need it to be reachable across namespaces).
      host: "127.0.0.1",
      port: 9000,
      // DNS-rebinding protection stays on: IP hosts (127.0.0.1, the
      // Tailscale 100.x address) and localhost are always allowed —
      // so `http://100.80.72.28:9300/` works without config. Names
      // must be listed explicitly, because they arrive as the Host
      // header:
      //
      //   - `tailscale serve` (the HTTPS that unlocks the microphone
      //     API + service worker on phones) forwards the MagicDNS
      //     name, e.g. devbox-2.<tailnet>.ts.net;
      //   - MagicDNS also answers the SHORT name (devbox-2:9300) on
      //     the tailnet, and that is not covered by the ts.net
      //     wildcard — it is a bare hostname, which Vite blocks
      //     unless listed. That's the "Blocked request. This host
      //     (\"devbox-2\") is not allowed" error.
      //
      // The list is derived from this machine's Tailscale identity
      // (node name may differ from os.hostname() — devbox-2 vs
      // devbox), so it stays correct on another host without edits.
      // Composed setups add their service names via
      // VOIR_ALLOWED_HOSTS (docker-compose sets it to "web", which
      // is how the mock containers reach the UI).
      allowedHosts: allowedHostNames(),
    },
  };
});

// -----------------------------------------------------------------------
// tailscaleProxy
//
// Why not `server.host: true`? Vite's `server.host` takes a single
// address — one Node listener — so "loopback + Tailscale, but not
// LAN/WAN" can't be expressed with it. `true`/0.0.0.0 would bind
// every interface, including the public one.
//
// So: the dev server binds 127.0.0.1, and this plugin adds one TCP
// forwarder per Tailscale IPv4 (same port, Tailscale interface),
// piping bytes to the loopback listener. HTTP, HMR websocket, SSE —
// all just TCP, so everything passes through unchanged. The dev
// server never binds a non-Tailscale, non-loopback interface, and
// if Tailscale isn't running, the server stays loopback-only.
// -----------------------------------------------------------------------

/**
 * Host-header allowlist for Vite's dev server (DNS-rebinding guard).
 *
 * IP literals (127.0.0.1, ::1, the 100.x tailnet address) and
 * "localhost" are always allowed by Vite and need no entry. Names
 * must be listed, because a name arrives as the Host header — and
 * MagicDNS answers two shapes for the same node:
 *
 *   devbox-2.tailedc77f.ts.net   (FQDN: what `tailscale serve` sends)
 *   devbox-2                     (short name: bare, NOT matched by
 *                                 the .ts.net wildcard)
 *
 * Deriving both from `tailscale status --json` keeps this correct
 * when the tailnet domain changes or the checkout moves to another
 * machine (whose node name may differ from os.hostname() — here the
 * node is "devbox-2" while the host is "devbox").
 *
 * Containers have no tailscale binary: the call fails soft and the
 * compose setup supplies its service names via VOIR_ALLOWED_HOSTS
 * (docker-compose.yml sets "web").
 */
function allowedHostNames(): string[] {
  const names = new Set<string>([
    // Belt-and-braces for on-host access by machine name.
    os.hostname(),
    // Explicit extras: comma-separated hostnames ("web,mock-a, …").
    ...(process.env.VOIR_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ]);
  try {
    const out = execFileSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const self = (JSON.parse(out) as { Self?: { DNSName?: string; HostName?: string } })
      .Self;
    const fqdn = String(self?.DNSName ?? "").replace(/\.$/, "");
    if (fqdn) {
      names.add(fqdn);
      // ".tailXXXX.ts.net" allows every node in this tailnet, so a
      // sibling device hitting this dev server by name works too.
      const dot = fqdn.indexOf(".");
      if (dot > 0) names.add(fqdn.slice(dot));
    }
    if (self?.HostName) names.add(String(self.HostName));
  } catch {
    // Not a tailnet host (container, CI, laptop without Tailscale).
  }
  return [...names];
}

/**
 * Tailscale assigns each node an IPv4 in 100.64.0.0/10 (the CGNAT
 * range). Anything in that range on a non-internal interface is a
 * tailnet address. (Tailscale's ULA range, fd7a:115c:a1e0::/48, is
 * IPv6 — browsers prefer the v4 address, and one forwarder is
 * enough, so v6 is ignored.)
 */
function tailscaleIPv4s(): string[] {
  const out = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal || String(a.family) !== "IPv4") continue;
      const m = /^100\.(\d+)\./.exec(a.address);
      if (!m) continue;
      const second = Number(m[1]);
      if (second >= 64 && second <= 127) out.add(a.address);
    }
  }
  return [...out];
}

function tailscaleProxy(): Plugin {
  const forwarders = new Set<net.Server>();
  const sockets = new Set<net.Socket>();

  function closeForwarders() {
    for (const f of forwarders) f.close();
    forwarders.clear();
    for (const s of sockets) s.destroy();
    sockets.clear();
  }

  return {
    name: "voir:tailscale-proxy",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      // Hook the http server's `listening` event rather than the
      // configureServer post-hook: react-router's dev setup runs
      // post-hooks before the socket is actually bound (the
      // post-hook sees httpServer.address() === null), and Vite may
      // bump the requested port when it's busy. `listening` fires
      // with the final port already bound on loopback.
      const httpServer = server.httpServer;
      if (!httpServer) return; // middlewareMode — nothing to forward to
      httpServer.once("listening", () => {
        const addr = httpServer.address();
        if (!addr || typeof addr === "string") return;
        const port = addr.port;

        // Voice conversation mode: raw-mic WebSocket endpoint,
        // only for upgrades at /api/voice — Vite's HMR socket is
        // untouched (its handler only matches its own path).
        // Dev-server-only: react-router-serve has no WS story.
        const detachVoice = attachVoiceServer(httpServer, (msg) =>
          server.config.logger.info(msg, { timestamp: false }),
        );
        // Neural narration: same proxy pattern, /api/tts. No-op for
        // browsers without a key — the client falls back to
        // speechSynthesis.
        const detachTts = attachTtsServer(httpServer, (msg) =>
          server.config.logger.info(msg, { timestamp: false }),
        );
        const stt = (process.env.VOICE_STT_PROVIDER ?? "mock").toLowerCase();
        server.config.logger.info(
          `  voice    →  STT: ${stt === "deepgram" ? `deepgram/${process.env.VOICE_STT_MODEL ?? "nova-2"}` : "mock (no key)"}`,
          { timestamp: false },
        );

        for (const ip of tailscaleIPv4s()) {
          const fwd = net.createServer((socket) => {
            const upstream = net.connect(port, "127.0.0.1");
            sockets.add(socket);
            sockets.add(upstream);
            const drop = () => {
              socket.destroy();
              upstream.destroy();
            };
            socket.on("error", drop);
            upstream.on("error", drop);
            socket.pipe(upstream).pipe(socket);
            socket.on("close", () => sockets.delete(socket));
            upstream.on("close", () => sockets.delete(upstream));
          });

          fwd.on("error", (err) => {
            server.config.logger.warn(
              `tailscale proxy on ${ip}:${port} failed: ${err.message}`,
            );
            forwarders.delete(fwd);
          });

          fwd.listen(port, ip, () => {
            forwarders.add(fwd);
            server.config.logger.info(
              `  tailnet  →  http://${ip}:${port}/  (Tailscale only; LAN/WAN not bound)`,
              { timestamp: false },
            );
          });
        }

        if (tailscaleIPv4s().length === 0) {
          server.config.logger.warn(
            "no Tailscale interface found — dev server is loopback-only. " +
              "Start Tailscale (or use docker compose) to expose it to your tailnet.",
          );
        }

        httpServer.on("close", () => {
          closeForwarders();
          detachVoice();
          detachTts();
        });
      });
    },
  };
}