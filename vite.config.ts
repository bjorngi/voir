import os from "node:os";
import net from "node:net";
import type { Plugin, ViteDevServer } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
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
    // Tailscale 100.x address) and localhost are always allowed.
    // The tailnet hostname must be allowed explicitly because
    // `tailscale serve` (which provides the HTTPS that unlocks
    // the microphone API + service worker on phones — plain HTTP
    // over the tailnet is not a secure context) forwards it as
    // the Host header. Scoped to this tailnet's subdomain, not
    // all of ts.net.
    allowedHosts: [".tailedc77f.ts.net"],
  },
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

        httpServer.on("close", closeForwarders);
      });
    },
  };
}