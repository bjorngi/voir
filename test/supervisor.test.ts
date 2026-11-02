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

/**
 * Teardown: SIGTERM, then WAIT for the actual exit (poll, ~4s
 * budget) before escalating. A test-file process owns the pipes
 * its children run on: a SIGKILL that lands mid-shutdown can
 * orphan a child (daemon → agents), the orphan keeps the pipe
 * open, and the runner waits on the file process forever. The
 * old fixed 300ms grace raced exactly that way, intermittently.
 */
function killSoon(child: ChildProcess, budgetMs = 4_000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, budgetMs);
    child.once("close", () => {
      clearTimeout(t);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

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
  preset?: string;
  presetOptions?: string[];
  supervisor?: { port: number; token?: string };
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
        preset: body.preset,
        presetOptions: body.presetOptions,
        supervisor: body.supervisor,
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

test("voir-supervisor: unnamed adds get generated, persisted identities", async () => {
  const workdir = await mkdtemp(join(tmpdir(), "voir-sup4-"));
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

  const sup = startSupervisor(configPath, statePath, apiPort);
  try {
    const api = `http://127.0.0.1:${apiPort}`;
    assert(
      await until(() =>
        (async () => {
          try {
            const res = await fetch(`${api}/health`);
            return res.ok;
          } catch {
            return false;
          }
        })(),
      ),
      "daemon never came up",
    );

    // Two unnamed adds, same preset, same dir: distinct generated
    // identities (mock-<hex6>), both persisted in the state file.
    const r1 = await (await fetch(`${api}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: workdir, preset: "mock" }),
    })).json() as { name: string };
    const r2 = await (await fetch(`${api}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: workdir, preset: "mock" }),
    })).json() as { name: string };
    assert.match(r1.name, /^mock-[0-9a-f]{6}$/, "generated name should be <preset>-<hex6>");
    assert.match(r2.name, /^mock-[0-9a-f]{6}$/);
    assert.notEqual(r1.name, r2.name, "two unnamed adds must not collide");

    // Both are persisted in the state file (identity survives boots).
    const state = JSON.parse(await readFile(statePath, "utf8")) as Array<{ name?: string }>;
    assert.deepEqual(
      state.map((e) => e.name).sort(),
      [r1.name, r2.name].sort(),
    );

    // Both registered with Voir under their generated names.
    assert(
      await until(() =>
        stub.registrations.some((r) => r.agentName === r1.name) &&
        stub.registrations.some((r) => r.agentName === r2.name),
      ),
      "generated-name agents never registered",
    );
  } finally {
        await killSoon(sup);
    stub.server.close();
    stub.server.closeAllConnections();
  }
});

test("acp-spawn: no --name registers a generated identity", async () => {
  const workdir = await mkdtemp(join(tmpdir(), "voir-spawn-noname-"));
  const stub = await startStubVoir();
  const stubUrl = `http://127.0.0.1:${(stub.server.address() as { port: number }).port}`;

  const child = spawn(process.execPath, [
    join(ROOT, "bin/acp-spawn.mjs"),
    "--agent", `node ${join(ROOT, "bin/mock-acp.mjs")}`,
    "--ui", stubUrl,
  ], { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] });

  try {
    assert(
      await until(() =>
        stub.registrations.some(
          (r) => typeof r.agentName === "string" && /^agent-[0-9a-f]{6}$/.test(r.agentName),
        ),
      ),
      "unnamed spawn never registered with a generated name",
    );
    const reg = stub.registrations.find(
      (r) => typeof r.agentName === "string" && /^agent-[0-9a-f]{6}$/.test(r.agentName),
    )!;
    assert.equal(reg.method, "POST");
    assert.equal(reg.path, workdir);
  } finally {
        await killSoon(child);
    stub.server.close();
    stub.server.closeAllConnections();
  }
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
        await killSoon(a);
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
        await killSoon(sup);
    stub.server.close();
    stub.server.closeAllConnections();
  }
});
test("voir-supervisor: switching an agent's preset restarts it under the new command", async () => {
  const workdir = await mkdtemp(join(tmpdir(), "voir-sup-switch-"));
  const configPath = join(workdir, "config.json");
  const statePath = join(workdir, "agents.json");
  const apiPort = await findFreePort();

  const stub = await startStubVoir();
  const stubUrl = `http://127.0.0.1:${(stub.server.address() as { port: number }).port}`;
  const mockCmd = `node ${join(ROOT, "bin/mock-acp.mjs")}`;
  // A script that runs forever but speaks no ACP: the bridge comes
  // up (that's the launcher's), the agent never answers a JSON-RPC
  // request — the sharp runtime proof that the CHILD was swapped,
  // not just the registration label. A file, not an inline -e:
  // the launcher splits the command spec on whitespace, so a
  // quoted argv would break (and, crashed, would loop-restart and
  // spam registrations, which the assertions below count on not
  // happening).
  const sleeperPath = join(workdir, "sleep-forever.mjs");
  await writeFile(sleeperPath, "setTimeout(() => {}, 1e9);\n");
  await writeFile(
    configPath,
    JSON.stringify({
      ui: stubUrl,
      presets: { mock: mockCmd, sleeper: `node ${sleeperPath}` },
    }),
  );
  await writeFile(
    statePath,
    JSON.stringify([{ dir: workdir, preset: "mock", name: "sw" }]),
  );

  const sup = startSupervisor(configPath, statePath, apiPort);
  try {
    const api = `http://127.0.0.1:${apiPort}`;
    assert(
      await until(() =>
        (async () => {
          try {
            return (await fetch(`${api}/health`)).ok;
          } catch {
            return false;
          }
        })(),
      ),
      "daemon never came up",
    );

    // 1. Boot registration carries supervisor awareness: which
    //    preset runs, the catalog's names, and the loopback API
    //    coordinates a proxy needs (no raw commands anywhere).
    assert(
      await until(() =>
        stub.registrations.some((r) => r.method === "POST" && r.agentName === "sw"),
      ),
      "sw never registered",
    );
    const first = stub.registrations.find((r) => r.agentName === "sw")!;
    assert.equal(first.preset, "mock");
    assert.deepEqual(
      (first.presetOptions ?? []).slice().sort(),
      ["mock", "sleeper"],
    );
    assert.equal(first.supervisor?.port, apiPort);
    assert.equal(first.supervisor?.token, undefined, "no token configured — none may be sent");

    // The supervised bridge answers the health probe (child alive).
    const ping = await fetch(first.agentUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
    });
    assert.equal(ping.status, 204);

    // 2. Switch to the sleeper preset via the API.
    const patch = await fetch(`${api}/agents/sw`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "sleeper" }),
    });
    assert.equal(patch.status, 200);
    const patchBody = (await patch.json()) as {
      name: string;
      preset: string;
      previous: string;
      changed: boolean;
    };
    assert.equal(patchBody.name, "sw");
    assert.equal(patchBody.previous, "mock");
    assert.equal(patchBody.preset, "sleeper");
    assert.equal(patchBody.changed, true);

    // 3. The agent restarts under the new command: a NEW
    //    registration POST for "sw" with the flipped preset
    //    arrives promptly (the periodic re-registration is 30s
    //    apart, so a POST within seconds of the PATCH can only
    //    come from the restart).
    const postCount = stub.registrations.filter(
      (r) => r.method === "POST" && r.agentName === "sw",
    ).length;
    assert(
      await until(
        () =>
          stub.registrations.filter(
            (r) => r.method === "POST" && r.agentName === "sw",
          ).length > postCount,
        10_000,
      ),
      "preset switch never restarted the agent (no new registration)",
    );
    const second = stub.registrations
      .filter((r) => r.method === "POST" && r.agentName === "sw")
      .at(-1)!;
    assert.equal(second.preset, "sleeper");
    // The folder was NOT unregistered on a switch (Voir must keep
    // it so the new child's registration swaps the leg in place).
    assert(
      !stub.registrations.some(
        (r) => r.method === "DELETE" && (r.name === "sw" || r.path === workdir),
      ),
      "a preset switch must not unregister the folder",
    );

    // Desired state was rewritten; desired is never rewritten
    // except by an explicit switch like this one.
    const state = JSON.parse(await readFile(statePath, "utf8")) as Array<{
      dir: string;
      preset: string;
      name: string;
    }>;
    assert.deepEqual(state, [{ dir: workdir, preset: "sleeper", name: "sw" }]);

    // 4. Unknown preset is refused with the catalog's names.
    const bad = await fetch(`${api}/agents/sw`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "nope" }),
    });
    assert.equal(bad.status, 400);
    const badBody = (await bad.json()) as { available: string[] };
    assert.deepEqual(badBody.available.sort(), ["mock", "sleeper"]);
    const stateAfterBad = JSON.parse(await readFile(statePath, "utf8")) as Array<{
      preset: string;
    }>;
    assert.equal(stateAfterBad[0].preset, "sleeper", "a refused switch writes nothing");

    // 5. Idempotent switch: same preset → 200 changed:false, no restart.
    const swPostsBefore = stub.registrations.filter(
      (r) => r.method === "POST" && r.agentName === "sw",
    ).length;
    const same = await fetch(`${api}/agents/sw`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "sleeper" }),
    });
    assert.equal(same.status, 200);
    assert.equal(((await same.json()) as { changed: boolean }).changed, false);
    await sleep(1_500);
    assert.equal(
      stub.registrations.filter(
        (r) => r.method === "POST" && r.agentName === "sw",
      ).length,
      swPostsBefore,
      "an idempotent switch must not restart the agent",
    );

    // 6. The CLI set-command goes through the daemon: switch back
    //    to the mock preset, and the restarted child is a REAL ACP
    //    agent again (session/new answers through the bridge).
    const cli = spawn(process.execPath, [
      join(ROOT, "bin/voir-supervisor.mjs"),
      "set",
      "sw",
      "--preset",
      "mock",
      "--state",
      statePath,
      "--config",
      configPath,
    ]);
    let cliDone: { code: number | null; out: string };
    cliDone = await new Promise((resolve) => {
      let out = "";
      cli.stdout!.on("data", (d: Buffer) => (out += d.toString()));
      cli.stderr!.on("data", (d: Buffer) => (out += d.toString()));
      cli.on("close", (code) => resolve({ code, out }));
      setTimeout(() => resolve({ code: -1, out }), 10_000);
    });
    assert.equal(cliDone.code, 0, `CLI set failed: ${cliDone.out}`);
    assert.match(cliDone.out, /mock/);

    // Wait for the re-registration (preset back to mock) ...
    assert(
      await until(() =>
        stub.registrations.some(
          (r) => r.method === "POST" && r.agentName === "sw" && r.preset === "mock" &&
            r !== first,
        ),
      ),
      "CLI set never restarted the agent",
    );
    // ... and probe the new bridge with a real ACP call. mock-acp
    // answers session/new; the sleeper child never would (504).
    const running = stub.registrations
      .filter((r) => r.method === "POST" && r.agentName === "sw" && r.preset === "mock")
      .at(-1)!;
    const sn = await fetch(running.agentUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { cwd: workdir },
      }),
    });
    assert.ok(sn.ok, "mock preset child should answer ACP calls");
    const snBody = (await sn.json()) as { result?: { sessionId?: string } };
    assert.ok(snBody.result?.sessionId, "session/new should return a session id");

    // 7. Unknown agent: 404, nothing written.
    const missing = await fetch(`${api}/agents/nothing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "mock" }),
    });
    assert.equal(missing.status, 404);
  } finally {
        await killSoon(sup);
    stub.server.close();
    stub.server.closeAllConnections();
  }
});
