import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { HttpJsonRpcTransport } from "../app/lib/acp-client.server";

/**
 * Transport-level reconnect behavior of HttpJsonRpcTransport,
 * against a real HTTP server shaped like the acp-spawn bridge:
 *
 *   POST <url>  JSON-RPC → 200/204
 *   GET  <url>  text/event-stream, one JSON-RPC message per data: line
 *
 * These tests pin the contract that the silent-divergence fix
 * depends on: a dropped stream is reopened, onReconnect fires
 * once per recovery, and endpoints that never offered SSE are
 * not hammered. Transports are always closed in `finally` —
 * an open SSE socket keeps the process (and the test runner)
 * alive forever.
 */

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert(addr && typeof addr === "object");
      resolve(`http://127.0.0.1:${addr.port}/`);
    });
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll `cond` until it returns true (or time out). */
async function until(cond: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await sleep(10);
  }
  return true;
}

function fast(): { backoffBaseMs: number; backoffCapMs: number } {
  return { backoffBaseMs: 10, backoffCapMs: 25 };
}

test("HttpJsonRpcTransport: reopens the stream after a drop and fires onReconnect", async () => {
  let opens = 0;
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      opens += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { opens },
        })}\n\n`,
      );
      if (opens === 1) {
        // Drop the first stream immediately, like a proxy cut.
        res.end();
      }
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  const url = await listen(server);
  const t = new HttpJsonRpcTransport(url, fast());
  try {
    const got: number[] = [];
    let reconnects = 0;
    t.onMessage((m) => {
      const p = m.params as { opens?: number } | undefined;
      if (p?.opens !== undefined) got.push(p.opens);
    });
    t.onReconnect(() => {
      reconnects += 1;
    });

    // First stream delivers message 1, then the server ends it.
    assert(await until(() => got.length >= 1), "first message never arrived");
    assert.equal(reconnects, 0, "onReconnect must not fire for the first open");

    // The transport must reopen by itself and see message 2.
    assert(await until(() => got.length >= 2), "stream was not reopened");
    assert.deepEqual(got, [1, 2], "messages arrived out of order");
    assert.equal(reconnects, 1, "onReconnect should fire exactly once");
    assert.ok(opens >= 2);
  } finally {
    t.close();
    server.close();
    server.closeAllConnections();
  }
});

test("HttpJsonRpcTransport: endpoints that never offered SSE are not retried", async () => {
  let gets = 0;
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      gets += 1;
      res.writeHead(404);
      res.end();
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  const url = await listen(server);
  const t = new HttpJsonRpcTransport(url, fast());
  try {
    t.onMessage(() => {});
    await sleep(200); // several backoff periods
    assert.equal(gets, 1, "a non-SSE endpoint must not be retried");
  } finally {
    t.close();
    server.close();
    server.closeAllConnections();
  }
});

test("HttpJsonRpcTransport: unreachable endpoints are retried until they appear", async () => {
  // Pick a port, close the server, point a transport at the dead
  // port, then bring a server up on the same port.
  const probe = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "up" })}\n\n`);
  });
  const url = await listen(probe);
  const port = Number(new URL(url).port);
  probe.close();
  probe.closeAllConnections();
  await sleep(50);

  const t = new HttpJsonRpcTransport(url, fast());
  const seen: string[] = [];
  let reconnects = 0;
  t.onMessage((m) => seen.push((m as { method?: string }).method ?? "?"));
  t.onReconnect(() => {
    reconnects += 1;
  });
  const up = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "up" })}\n\n`);
  });
  await new Promise<void>((resolve) => {
    up.listen(port, "127.0.0.1", resolve);
  });
  try {
    // First open failed (connection refused); the transport must
    // keep retrying — swallowing it would strand an agent that
    // was merely down at open time.
    assert.equal(seen.length, 0, "nothing seen yet");
    assert(await until(() => seen.length >= 1), "no stream after endpoint came up");
    assert.deepEqual(seen, ["up"]);
    assert.equal(reconnects, 0, "first successful open is not a reconnect");
  } finally {
    t.close();
    up.close();
    up.closeAllConnections();
  }
});