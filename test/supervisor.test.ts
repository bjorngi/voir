import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer, type Server } from "node:http";

// Local copy of acp-lib's findFreePort: importing the .mjs from
// TypeScript would need a declaration file; the helper is 8 lines.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createHttpServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * End-to-end supervisor test: bin/voir-supervisor converging a
 * small fleet against a stub Voir (an HTTP server that records
 * POST/DELETE /api/folders).
 *
 * Under test:
 *   - boot: desired agents from the state file are launched and
 *     registered (path + name — the Phase 2 keying)
 *   - add via the API: second agent on the same path, state file
 *     updated (desired state, atomically written)
 *   - rm via the API: agent stopped, unregistered, state updated
 *   - crash: the child is restarted with backoff and re-registers
 *   - shutdown: running agents unregister
 *   - the CLI finds the daemon via the discovery file
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(
  cond: () => boolean | Promise<boolean>,
  ms = 20_000,
) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}

interface Registration {
  method: string;
  path: string;
  agentName?: string;
  agentUrl?: string;
  name?: string;
}

async function startStubVoir(): Promise<{
  server: Server;
  registrations: Registration[];
}> {
  const registrations: Registration[] = [];
  const server = createHttpServer(async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const url = new URL(req.url!, "http://stub");
    if (req.method === "POST" && url.pathname === "/api/folders") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      registrations.push({
        method: "POST",
        path: body.path,
        agentName: body.agentName,
        agentUrl: body.agentUrl,
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ browse: `/f/${body.path}` }));
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/api/folders") {
      registrations.push({
        method: "DELETE",
        path: url.searchParams.get("path") ?? "",
        name: url.searchParams.get("name") ?? undefined,
      });
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, registrations };
}

function startSupervisor(
  configPath: string,
  statePath: string,
  apiPort: number,
): ChildProcess {
  return spawn(
    process.execPath,
    [
      join(ROOT, "bin/voir-supervisor.mjs"),
      "--config",
      configPath,
      "--state",
      statePath,
      "--api-port",
      String(apiPort),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

test("voir-supervisor: refuses a config path that collides with its own discovery file", async () => {
  const workdir = await mkdtemp(join(tmpdir(), "voir-sup3-"));
  const statePath = join(workdir, "agents.json");
  // The discovery file is always <state-dir>/supervisor.json; a
  // config there would be overwritten on boot. The daemon must
  // refuse instead of clobbering it.
  const configPath = join(workdir, "supervisor.json");
  await writeFile(configPath, JSON.stringify({ ui: "http://localhost:9", presets: {} }));
  await writeFile(statePath, "[]");

  const p = startSupervisor(configPath, statePath, await findFreePort());
  const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
    let out = "";
    p.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr!.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", (code) => resolve({ code, out }));
  });
  assert.notEqual(result.code, 0);
  assert.match(result.out, /must not be the supervisor's own discovery file/);
  // And the config file was not touched.
  const after = JSON.parse(await readFile(configPath, "utf8")) as { ui: string };
  assert.equal(after.ui, "http://localhost:9");
});

test("voir-supervisor: a second daemon on the same port dies cleanly", async () => {
  const workdir = await mkdtemp(join(tmpdir(), "voir-sup2-"));
  const configPath = join(workdir, "config.json");
  const statePath = join(workdir, "agents.json");
  const apiPort = await findFreePort();

  const stub = await startStubVoir();
  const stubUrl = `http://127.0.0.1:${(stub.server.address() as { port: number }).port}`;
  await writeFile(
    configPath,
    JSON.stringify({ ui: stubUrl, presets: { mock: `node ${join(ROOT, "bin/mock-acp.mjs")}` } }),
  );
  await writeFile(statePath, "[]");

  // Daemon A boots and listens.
  const a = startSupervisor(configPath, statePath, apiPort);
  let aOut = "";
  a.stdout!.on("data", (b: Buffer) => (aOut += b.toString()));
  assert(
    await until(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${apiPort}/health`);
        return res.ok;
      } catch {
        return false;
      }
    }),
    "daemon A never came up",
  );

  try {
    // Daemon B on the same port: must exit non-zero with a clear
    // message instead of crashing on an unhandled listen error
    // and leaving a poisoned discovery file.
    const b = startSupervisor(configPath, statePath, apiPort);
    const bResult = await new Promise<{ code: number | null; out: string }>(
      (resolve) => {
        let out = "";
        b.stdout!.on("data", (d: Buffer) => (out += d.toString()));
        b.stderr!.on("data", (d: Buffer) => (out += d.toString()));
        b.on("close", (code) => resolve({ code, out }));
      },
    );
    assert.notEqual(bResult.code, 0, "daemon B should have exited");
    assert.match(
      bResult.out,
      /port in use — is another voir-supervisor already running\?/,
    );

    // Daemon A is unaffected, and the discovery file still
    // points at A (B never got to write it).
    const health = await (await fetch(`http://127.0.0.1:${apiPort}/health`)).json() as {
      ok: boolean;
    };
    assert.equal(health.ok, true);
    const disc = JSON.parse(await readFile(join(workdir, "supervisor.json"), "utf8")) as {
      pid: number;
    };
    assert.equal(disc.pid, a.pid, "discovery must still point at daemon A");
  } finally {
    a.kill("SIGTERM");
    await sleep(300);
    a.kill("SIGKILL");
    stub.server.close();
    stub.server.closeAllConnections();
  }
});

test("voir-supervisor: converges a fleet, restarts crashes, honors rm", async () => {
  const workdir = await mkdtemp(join(tmpdir(), "voir-sup-"));
  const configPath = join(workdir, "config.json");
  const statePath = join(workdir, "agents.json");

  const stub = await startStubVoir();
  const stubUrl = `http://127.0.0.1:${(stub.server.address() as { port: number }).port}`;
  const apiPort = await findFreePort();

  await writeFile(
    configPath,
    JSON.stringify(
      {
        ui: stubUrl,
        presets: {
          mock: `node ${join(ROOT, "bin/mock-acp.mjs")}`,
          crashy: `node -e "setTimeout(()=>process.exit(3), 200)"`,
        },
      },
      null,
      2,
    ),
  );
  await writeFile(statePath, JSON.stringify([
    { dir: workdir, preset: "mock", name: "m1" },
  ]));

  const sup = startSupervisor(configPath, statePath, apiPort);
  try {
    const api = `http://127.0.0.1:${apiPort}`;

    // 1. Boot convergence: m1 is launched and registered.
    assert(
      await until(() =>
        stub.registrations.some((r) => r.method === "POST" && r.agentName === "m1"),
      ),
      "m1 never registered",
    );
    const m1 = stub.registrations.find(
      (r) => r.method === "POST" && r.agentName === "m1",
    )!;
    assert.equal(m1.path, workdir);

    // The supervised bridge answers the health probe.
    const ping = await fetch(m1.agentUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
    });
    assert.equal(ping.status, 204, "supervised bridge should be alive");

    // 2. Add a second agent on the same path (Phase 2 keying).
    const add = await fetch(`${api}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: workdir, preset: "mock", name: "m2" }),
    });
    assert.equal(add.status, 201);
    assert(
      await until(() =>
        stub.registrations.some((r) => r.method === "POST" && r.agentName === "m2"),
      ),
      "m2 never registered",
    );

    // Unknown preset is refused, and the available names come back.
    const bad = await fetch(`${api}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: workdir, preset: "nope", name: "x" }),
    });
    assert.equal(bad.status, 400);
    const badBody = (await bad.json()) as { available: string[] };
    assert.deepEqual(badBody.available.sort(), ["crashy", "mock"]);

    // Desired state was persisted: two entries.
    const stateAfterAdd = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(stateAfterAdd.length, 2);

    // 3. Crash loop: the crashy preset dies and must be
    //    restarted (re-registered) with backoff.
    const addBoom = await fetch(`${api}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: workdir, preset: "crashy", name: "boom" }),
    });
    assert.equal(addBoom.status, 201);
    assert(
      await until(
        () =>
          stub.registrations.filter((r) => r.agentName === "boom").length >= 2,
        25_000,
      ),
      "boom was never restarted after crashing",
    );
    const listing = (await (await fetch(`${api}/agents`)).json()) as {
      agents: { name: string; status: string; crashes: number }[];
    };
    const boom = listing.agents.find((a) => a.name === "boom");
    assert.ok(boom, "boom missing from listing");
    assert.ok(boom!.crashes > 0, "crash bookkeeping missing");

    // 4. rm: m1 is stopped and unregistered by name.
    const rm = await fetch(`${api}/agents/m1`, { method: "DELETE" });
    assert.equal(rm.status, 200);
    assert(
      await until(() =>
        stub.registrations.some(
          (r) => r.method === "DELETE" && r.name === "m1",
        ),
      ),
      "m1 was never unregistered",
    );
    const stateAfterRm = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(stateAfterRm.length, 2); // m2 + boom remain

    // 5. The CLI finds the daemon via the discovery file.
    const ls = await new Promise<string>((resolve) => {
      let out = "";
      const p = spawn(process.execPath, [
        join(ROOT, "bin/voir-supervisor.mjs"),
        "ls",
        "--state",
        statePath,
      ]);
      p.stdout.on("data", (b) => (out += b.toString()));
      p.on("close", () => resolve(out));
    });
    assert.match(ls, /m2/, "CLI listing should include m2");
  } finally {
    sup.kill("SIGTERM");
    await sleep(300);
    sup.kill("SIGKILL");
    stub.server.close();
    stub.server.closeAllConnections();
  }
});