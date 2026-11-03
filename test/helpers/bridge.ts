// Shared helper for tests that need a real acp-spawn bridge.
//
// Spawns `bin/acp-spawn.mjs` (with --no-register, exactly like the
// resync test does), waits for its "bridge for … on http://…/"
// stdout line, and hands back the bridge URL. The caller kills the
// child; `child.kill()` tears the bridge and its agent down.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)); // repo root (helper is in test/helpers/)

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function until(cond: () => boolean, ms = 10_000) {
  return (async () => {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) return false;
      await sleep(20);
    }
    return true;
  })();
}

export interface Bridge {
  child: ChildProcess;
  agentUrl: string;
}

export function spawnBridge(
  folder: string,
  fixture: string,
  name = "it",
): Promise<Bridge> {
  const child = spawn(
    process.execPath,
    [
      join(ROOT, "bin/acp-spawn.mjs"),
      "--agent",
      `node ${join(ROOT, "test/fixtures", fixture)}`,
      "--name",
      name,
      "--ui",
      "http://127.0.0.1:1",
      "--no-register",
    ],
    { cwd: folder, stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise<Bridge>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("bridge never came up")),
      10_000,
    );
    let settled = false;
    const settle = (ok: boolean, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) resolve({ child, agentUrl: agentUrl0! });
      else reject(err ?? new Error("spawnBridge failed"));
    };
    let agentUrl0: string | null = null;
    let errText = "";
    child.stderr!.on("data", (b: Buffer) => {
      errText += b.toString();
    });
    child.stdout!.on("data", (b: Buffer) => {
      const m = b.toString().match(/on (http:\/\/\S+)/);
      if (m) {
        agentUrl0 = m[1];
        settle(true);
      }
    });
    child.on("exit", (code, signal) => {
      settle(
        false,
        new Error(
          `acp-spawn exited before listening (code ${code}, signal ${signal})${
            errText ? "\nstderr: " + errText : ""
          }`,
        ),
      );
    });
  });
}

/** POST one JSON-RPC message to the bridge. */
export function postRpc(agentUrl: string, body: unknown): Promise<Response> {
  return fetch(agentUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}