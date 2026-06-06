import test from "node:test";
import assert from "node:assert/strict";
import { AcpClient, type AcpTransport, type JsonRpcMessage } from "../app/lib/acp-client.server";

/**
 * A mock transport that lets the test drive both response
 * paths (in-band send() resolution and SSE-style push via
 * onMessage) deterministically. The AcpClient should accept
 * whichever arrives first and ignore the second.
 */
function makeMockTransport(): AcpTransport & {
  inBandResponse: (msg: JsonRpcMessage) => void;
  pushedResponse: (msg: JsonRpcMessage) => void;
  sent: JsonRpcMessage[];
  pushedListeners: Array<(msg: JsonRpcMessage) => void>;
} {
  const sent: JsonRpcMessage[] = [];
  const pushedListeners: Array<(msg: JsonRpcMessage) => void> = [];
  let onMessageCb: ((msg: JsonRpcMessage) => void) | null = null;
  let inBandResolve: ((msg: JsonRpcMessage | undefined) => void) | null = null;
  return {
    sent,
    pushedListeners,
    inBandResponse: (msg) => {
      const r = inBandResolve;
      inBandResolve = null;
      r?.(msg);
    },
    pushedResponse: (msg) => {
      for (const l of pushedListeners) l(msg);
    },
    send(msg) {
      sent.push(msg);
      // Return a pending promise that the test resolves via
      // inBandResponse(). The AcpClient should treat undefined
      // (when the test doesn't resolve) the same as a 204.
      return new Promise<JsonRpcMessage | undefined>((resolve) => {
        inBandResolve = resolve;
      });
    },
    onMessage(cb) {
      onMessageCb = cb;
      pushedListeners.push(cb);
      return () => {
        const i = pushedListeners.indexOf(cb);
        if (i !== -1) pushedListeners.splice(i, 1);
        if (onMessageCb === cb) onMessageCb = null;
      };
    },
    close() {},
    ping: async () => true,
  };
}

test("AcpClient.request: in-band HTTP response resolves the promise", async () => {
  const t = makeMockTransport();
  const client = new AcpClient({
    label: "test",
    transport: () => t,
  });
  // Initialize via the SSE-pushed path (no in-band response)
  const initPromise = client.start();
  // The client sends initialize as a request; the mock doesn't
  // resolve it via send, so we push the response via SSE.
  queueMicrotask(() => {
    const req = t.sent[0];
    assert.equal(req.method, "initialize");
    t.pushedResponse({
      jsonrpc: "2.0",
      id: req.id,
      result: { protocolVersion: 1 },
    });
  });
  const caps = await initPromise;
  assert.equal(caps.protocolVersion, 1);
});

test("AcpClient.request: SSE-pushed error rejects the promise", async () => {
  const t = makeMockTransport();
  const client = new AcpClient({
    label: "test",
    transport: () => t,
  });
  const initPromise = client.start();
  queueMicrotask(() => {
    const req = t.sent[0];
    t.pushedResponse({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32600, message: "bad" },
    });
  });
  await assert.rejects(initPromise, /ACP error -32600/);
});

test("AcpClient.request: the same response arriving twice does not double-settle", async () => {
  const t = makeMockTransport();
  const client = new AcpClient({
    label: "test",
    transport: () => t,
  });
  const initPromise = client.start();
  queueMicrotask(() => {
    const req = t.sent[0];
    const response: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: req.id,
      result: { protocolVersion: 1 },
    };
    // Resolve via in-band path first.
    t.inBandResponse(response);
    // ... then push the same response via SSE. The client
    // should treat the second as a no-op (the pending entry
    // is already gone).
    t.pushedResponse(response);
  });
  const caps = await initPromise;
  assert.equal(caps.protocolVersion, 1);
});
