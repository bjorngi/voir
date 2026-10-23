import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createRegistrar } from "../bin/acp-lib.mjs";

// Unit test of createRegistrar's keep-alive loop — the piece the
// e2e supervisor test can't reach (its interval is 30s; here it
// is injected). The regression: a failed keep-alive POST used to
// flip `registered` to false, and the interval's `!registered`
// guard then skipped every future tick — "will retry" never did,
// and the agent went permanently invisible to a restarted Voir.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(
  cond: () => boolean | Promise<boolean>,
  ms = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
}

/** Stub Voir: counts POST /api/folders, switchable 500s. */
async function startStubVoir(): Promise<{
  server: Server;
  posts: () => number;
  setFail: (v: boolean) => void;
  close: () => Promise<void>;
}> {
  let count = 0;
  let fail = false;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || new URL(req.url!, "http://stub").pathname !== "/api/folders") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    count += 1;
    if (fail) {
      res.writeHead(500);
      res.end("stub outage");
    } else {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ browse: "/f/stub" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    posts: () => count,
    setFail: (v) => { fail = v; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("registrar: a lost registration is retried, not abandoned", async () => {
  const stub = await startStubVoir();
  const ui = `http://127.0.0.1:${(stub.server.address() as { port: number }).port}`;

  // Capture state-transition logs ("lost registration", "re-registered").
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => logs.push(args.join(" "));

  const registrar = createRegistrar({
    ui,
    folder: "/tmp/stub-folder",
    agentUrl: "http://127.0.0.1:1/",
    agentName: "stub-agent",
    reregisterMs: 50,
  });

  try {
    const body = (await registrar.register()) as { browse: string };
    assert.equal(body.browse, "/f/stub");
    assert.equal(stub.posts(), 1, "initial registration POSTed once");
    registrar.keepRegistered();

    // --- Voir goes down: every keep-alive POST now fails.
    stub.setFail(true);
    assert(
      await until(() => logs.some((l) => l.includes("lost registration"))),
      "first failed keep-alive should log 'lost registration'",
    );

    // The regression: the loop must keep POSTing through the
    // outage (the old `!registered` guard skipped every tick
    // after the first failure, freezing the count forever).
    const duringOutage = stub.posts();
    assert(
      await until(() => stub.posts() > duringOutage, 2_000),
      "keep-alive must keep retrying while the UI is down",
    );

    // --- Voir comes back: the next POST re-registers.
    stub.setFail(false);
    assert(
      await until(() => logs.some((l) => l.includes("re-registered"))),
      "recovered registration should log 're-registered'",
    );

    // Routine re-registrations stay silent afterwards.
    const reRegCount = logs.filter((l) => l.includes("re-registered")).length;
    await sleep(150); // a few more successful ticks
    assert.equal(
      logs.filter((l) => l.includes("re-registered")).length,
      reRegCount,
      "routine keep-alive POSTs should not log",
    );

    // stop() halts the loop.
    const before = stub.posts();
    registrar.stop();
    await sleep(150);
    assert.equal(stub.posts(), before, "stop() must halt keep-alive POSTs");
  } finally {
    registrar.stop();
    console.log = origLog;
    console.error = origError;
    await stub.close();
  }
});