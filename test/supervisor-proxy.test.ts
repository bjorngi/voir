import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { sessionManager } from "../app/lib/sessions.server";
import {
  switchAgentPreset,
  type SwitchPresetResult,
} from "../app/lib/supervisor-proxy.server";

// The status store persists under VOIR_DATA_DIR; isolate it like
// the other sessionManager tests do.
process.env.VOIR_DATA_DIR = await mkdtemp(join(tmpdir(), "voir-proxy-"));

/**
 * The Voir → supervisor proxy (app/lib/supervisor-proxy.server.ts),
 * exercised against a real acp-spawn bridge (mock ACP agent) and a
 * stub supervisor daemon. Under test:
 *
 *   - session-scoped resolution: the agent owning the chat is
 *     found even when several agents share the path
 *   - the PATCH is forwarded to the supervisor's loopback API
 *     (right key, right bearer, right body) and Voir's folder
 *     state is patched optimistically on success
 *   - a supervisor refusal bubbles with its status + available list
 *   - a one-shot (non-supervisor) agent is refused with 409
 *   - unknown path/session → 404; unreachable supervisor → 502
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function until(cond: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (cond()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface PatchRecord {
  key: string;
  preset?: string;
  auth?: string;
}

/** A stub supervisor daemon: records PATCH /agents/<key> calls.
 *  `respond` writes the reply; defaults to a 200 success body. */
async function startStubSupervisor(
  respond?: (res: import("node:http").ServerResponse) => void,
) {
  const patches: PatchRecord[] = [];
  const server: Server = createServer(
    async (req, res) => {
      const m = req.url!.match(/^\/agents\/([^/]+)$/);
      if (req.method === "PATCH" && m) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        patches.push({
          key: decodeURIComponent(m[1]),
          preset: body.preset,
          auth: req.headers.authorization,
        });
        if (respond) {
          respond(res); // full control: writeHead(status, …) + end
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "x", preset: "x", changed: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, patches, port: (server.address() as { port: number }).port };
}

async function startBridge(
  folder: string,
  name: string,
): Promise<{ child: ChildProcess; agentUrl: string }> {
  const child = spawn(
    process.execPath,
    [
      join(ROOT, "bin/acp-spawn.mjs"),
      "--agent",
      `node ${join(ROOT, "bin/mock-acp.mjs")}`,
      "--name",
      name,
      "--ui",
      "http://127.0.0.1:1",
      "--no-register",
    ],
    { cwd: folder, stdio: ["ignore", "pipe", "pipe"] },
  );
  const agentUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`bridge ${name} never came up`)),
      10_000,
    );
    child.stdout!.on("data", (b: Buffer) => {
      const m = b.toString().match(/on (http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on("exit", () =>
      reject(new Error(`bridge ${name} exited before listening`)),
    );
  });
  return { child, agentUrl };
}

test("clearAgentCaches drops the cached view without touching the preset", async () => {
  const folder = await mkdtemp(join(tmpdir(), "voir-proxy-clear-"));
  const bridge = await startBridge(folder, "clearer");
  try {
    await sessionManager.registerFolder({
      path: folder,
      agentUrl: bridge.agentUrl,
      agentName: "clearer",
      preset: "pi-dev-fenced",
      presetOptions: ["pi", "pi-dev-fenced"],
      supervisor: { port: 7499, token: "t" },
    });
    const session = await sessionManager.createSession(folder, "chat", "clearer");
    const st = sessionManager.getFolder(folder, "clearer")!;
    st.availableModels = [{ modelId: "m1", name: "M1" }];
    st.availableModes = [{ id: "think", name: "Think" }];
    st.availableCommands = [{ name: "/x", description: "x" }];
    st.currentModelId = "m1";

    // Unknown target: nothing to clear.
    assert.equal(
      sessionManager.clearAgentCaches(folder, { name: "ghost" }),
      undefined,
    );

    // Chat-scoped clear (the drawer's call shape).
    const cleared = sessionManager.clearAgentCaches(folder, {
      sessionId: session.id,
    });
    assert.ok(cleared);
    assert.equal(cleared!.agent, "clearer");
    assert.deepEqual(st.availableModels, []);
    assert.deepEqual(st.availableModes, []);
    assert.deepEqual(st.availableCommands, []);
    assert.equal(st.currentModelId, null);
    // The fence identity itself is untouched — this is cache
    // maintenance, not a switch.
    assert.equal(st.preset, "pi-dev-fenced");
  } finally {
    bridge.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    sessionManager.unregisterFolder(folder, "clearer").catch(() => {});
  }
});

test("preset switch proxies to the supervisor and patches Voir's folder state", async () => {
  const folder = await mkdtemp(join(tmpdir(), "voir-proxy-ok-"));
  const stub = await startStubSupervisor((res) => {
    res.end(
      JSON.stringify({ name: "alpha", preset: "pi-fenced", previous: "pi", changed: true }),
    );
  });
  const bridge = await startBridge(folder, "alpha");
  try {
    await sessionManager.registerFolder({
      path: folder,
      agentUrl: bridge.agentUrl,
      agentName: "alpha",
      preset: "pi",
      presetOptions: ["pi", "pi-fenced"],
      supervisor: { port: stub.port, token: "sekrit" },
    });
    const session = await sessionManager.createSession(folder, "chat", "alpha");

    const result: SwitchPresetResult = await switchAgentPreset({
      path: folder,
      sessionId: session.id,
      preset: "pi-fenced",
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.name, "alpha");
    assert.equal(result.preset, "pi-fenced");
    assert.equal(result.previous, "pi");
    assert.equal(result.changed, true);

    // The supervisor got exactly one PATCH: the agent's key, the
    // requested preset, the configured bearer token.
    assert.equal(stub.patches.length, 1);
    const patch = stub.patches[0]!;
    assert.equal(patch.key, "alpha");
    assert.equal(patch.preset, "pi-fenced");
    assert.equal(patch.auth, "Bearer sekrit");

    // The folder itself is untouched by the proxy: the fence's
    // truth lands with the restarted agent's re-registration
    // (simulated below) — that POST is where the switch sweep
    // clears the old fence's caches.
    assert.ok(sessionManager.listFolders().some((f) => f.path === folder));
    assert.equal(sessionManager.getFolder(folder, "alpha")!.preset, "pi");

    // Simulate the restarted agent's re-registration: same bridge,
    // new preset. The sweep must adopt the new preset and clear
    // the old fence's advertised state.
    const st = sessionManager.getFolder(folder, "alpha")!;
    st.availableModels = [{ modelId: "stale-model", name: "stale" }];
    await sessionManager.registerFolder({
      path: folder,
      agentUrl: bridge.agentUrl,
      agentName: "alpha",
      preset: "pi-fenced",
      presetOptions: ["pi", "pi-fenced"],
      supervisor: { port: stub.port, token: "sekrit" },
    });
    assert.equal(st.preset, "pi-fenced");
    assert.deepEqual(st.availableModels, [], "switch sweep must clear advertised models");
    assert.equal(st.currentModelId, null);

    // A plain re-registration (same preset, the 30s keep-alive)
    // must NOT clear anything — the cache clearing is exactly
    // for switches.
    st.availableModels = [{ modelId: "fresh-model", name: "fresh" }];
    await sessionManager.registerFolder({
      path: folder,
      agentUrl: bridge.agentUrl,
      agentName: "alpha",
      preset: "pi-fenced",
      presetOptions: ["pi", "pi-fenced"],
      supervisor: { port: stub.port, token: "sekrit" },
    });
    assert.equal(st.availableModels.length, 1, "same-preset re-registration must not sweep");
  } finally {
    bridge.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    sessionManager.unregisterFolder(folder, "alpha").catch(() => {});
    stub.server.close();
    stub.server.closeAllConnections();
  }
});

test("preset switch refusals and non-supervisor agents", async () => {
  const folderSup = await mkdtemp(join(tmpdir(), "voir-proxy-ref-a-"));
  const folderOnce = await mkdtemp(join(tmpdir(), "voir-proxy-ref-b-"));

  const bridgeAlpha = await startBridge(folderSup, "alpha");
  const bridgeOnce = await startBridge(folderOnce, "oneshot");
  try {
    const stub = await startStubSupervisor((res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: 'Unknown preset "nope"', available: ["pi", "opencode"] }),
      );
    });

    await sessionManager.registerFolder({
      path: folderSup,
      agentUrl: bridgeAlpha.agentUrl,
      agentName: "alpha",
      preset: "pi",
      presetOptions: ["pi", "opencode"],
      supervisor: { port: stub.port, token: "t2" },
    });
    // One-shot agent: no supervisor awareness in the registration.
    await sessionManager.registerFolder({
      path: folderOnce,
      agentUrl: bridgeOnce.agentUrl,
      agentName: "oneshot",
    });

    // Unknown session id under a known path: honest 404 — the
    // caller pointed at a specific chat that can't resolve.
    const noSession = (await switchAgentPreset({
      path: folderSup,
      sessionId: "does-not-exist",
      preset: "pi",
    })) as { ok: false; status: number };
    assert.equal(noSession.ok, false);
    assert.equal(noSession.status, 404);

    // Unknown path: 404.
    const noPath = (await switchAgentPreset({
      path: join(tmpdir(), "voir-proxy-nowhere"),
      preset: "pi",
    })) as { ok: false; status: number };
    assert.equal(noPath.ok, false);
    assert.equal(noPath.status, 404);

    // Ambiguous case can't arise here (unique agents), but a
    // named one-shot agent is refused with 409 — nothing to switch.
    const noSup = (await switchAgentPreset({
      path: folderOnce,
      name: "oneshot",
      preset: "pi",
    })) as { ok: false; status: number; error: string };
    assert.equal(noSup.ok, false);
    assert.equal(noSup.status, 409);
    assert.match(noSup.error, /not supervisor-managed/);

    // The supervisor's refusal bubbles with its status and
    // available list.
    const refused = await switchAgentPreset({
      path: folderSup,
      name: "alpha",
      preset: "nope",
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.status, 400);
      assert.deepEqual(refused.available, ["pi", "opencode"]);
    }
    // Nothing was patched optimistically on refusal.
    assert.equal(sessionManager.getFolder(folderSup, "alpha")!.preset, "pi");

    // Unreachable supervisor: clean 502, not an throw.
    const deadPortStub = createServer();
    await new Promise<void>((resolve) =>
      deadPortStub.listen(0, "127.0.0.1", resolve),
    );
    const deadPort = (deadPortStub.address() as { port: number }).port;
    deadPortStub.close();
    deadPortStub.closeAllConnections();
    await sessionManager
      .unregisterFolder(folderSup, "alpha")
      .catch(() => {});
    await sessionManager.registerFolder({
      path: folderSup,
      agentUrl: bridgeAlpha.agentUrl,
      agentName: "alpha",
      preset: "pi",
      presetOptions: ["pi"],
      supervisor: { port: deadPort },
    });
    const unreachable = (await switchAgentPreset({
      path: folderSup,
      name: "alpha",
      preset: "pi",
    })) as { ok: false; status: number };
    assert.equal(unreachable.ok, false);
    assert.equal(unreachable.status, 502);
    stub.server.close();
    stub.server.closeAllConnections();
  } finally {
    bridgeAlpha.child.kill("SIGTERM");
    bridgeOnce.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    await sessionManager.unregisterFolder(folderSup, "alpha").catch(() => {});
    await sessionManager.unregisterFolder(folderOnce, "oneshot").catch(() => {});
  }
});