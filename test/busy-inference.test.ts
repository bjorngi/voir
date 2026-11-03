import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionManager } from "../app/lib/sessions.server";
import type { ChatMessage } from "../app/lib/chat-types";
import { postRpc, sleep, spawnBridge, until } from "./helpers/bridge";

// The status store persists under VOIR_DATA_DIR (docs/
// session-status.md): createSession auto-activates, which
// writes — isolate the tests' writes from the repo's dev-data.
process.env.VOIR_DATA_DIR = await mkdtemp(join(tmpdir(), "voir-busy-"));

/**
 * Busy inference with no owning prompt RPC (the client leg of the
 * long-turn fix).
 *
 * Voir's busy state is normally owned by runPrompt, which knows
 * exactly when the turn settles — but that owner disappears when
 * Voir restarts mid-turn or when the prompt leg fails while the
 * agent keeps working. ACP v1 has no "turn running" flag, yet the
 * inverse is provable from the wire: live (non-replay) agent
 * activity with no in-flight prompt means the agent IS busy. The
 * matching release signal is pi-acp's `_meta.piAcp.running: false`,
 * published on agent_end.
 *
 * The manual fixture fires updates out of turn via test/inject, so
 * both halves are exercised without ever sending a session/prompt.
 */

type BridgeT = Awaited<ReturnType<typeof spawnBridge>>;

async function setup(fixture: string, name: string) {
  const folder = await mkdtemp(join(tmpdir(), `voir-busy-${name}-`));
  const bridge: BridgeT = await spawnBridge(folder, fixture, name);
  await sessionManager.registerFolder({
    path: folder,
    agentUrl: bridge.agentUrl,
    agentName: name,
  });
  const session = await sessionManager.createSession(folder, `busy ${name}`);
  assert.ok(session, "session created");
  const busyEvents: boolean[] = [];
  const unsub = sessionManager.subscribe(session.id, (msg: ChatMessage) => {
    if (msg.role === "system" && msg.kind === "busy") {
      busyEvents.push((msg as unknown as { busy?: boolean }).busy ?? false);
    }
  });
  const inject = async (update: Record<string, unknown>) => {
    const res = await postRpc(bridge.agentUrl, {
      jsonrpc: "2.0",
      method: "test/inject",
      params: { sessionId: session.id, update },
    });
    assert.equal(res.status, 204);
  };
  return { folder, bridge, session, busyEvents, unsub, inject };
}

test("busy is claimed from live activity and released on the agent's idle signal", async () => {
  const t = await setup("manual-agent.mjs", "manual");
  try {
    // The interrupted-turn shape: the session has a user turn in
    // its transcript (replay pushed it, or Voir sent it before
    // the prompt leg died). The gate requires this before any
    // chunk can claim busy.
    await t.inject({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "the prompt that started the turn" },
    });

    // No prompt was ever sent against this session. A live chunk
    // alone must claim busy.
    await t.inject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "still working…" },
    });
    assert(
      await until(() => t.session.busy && t.busyEvents.at(-1) === true),
      "live chunk did not claim busy",
    );
    assert.equal(
      t.session.inFlightPrompts ?? 0,
      0,
      "no prompt should be in flight",
    );
    assert.ok(t.session.inferredBusy, "busy must be marked as inferred");

    // More activity while claimed must not re-broadcast busy.
    await t.inject({
      sessionUpdate: "plan",
      entries: [{ content: "keep going" }],
    });
    await sleep(150);
    assert.equal(
      t.busyEvents.filter(Boolean).length,
      1,
      "duplicate busy:true broadcasts",
    );

    // pi-acp's idle signal (agent_end, queue drained) releases it.
    await t.inject({
      sessionUpdate: "session_info_update",
      _meta: { piAcp: { queueDepth: 0, running: false } },
    });
    assert(
      await until(() => !t.session.busy && t.busyEvents.at(-1) === false),
      "running:false did not release the inferred busy",
    );

    // A title-only session_info_update (what /name sends) must NOT
    // claim busy — metadata is not activity.
    const before = t.busyEvents.filter(Boolean).length;
    await t.inject({ sessionUpdate: "session_info_update", title: "renamed" });
    await sleep(150);
    assert.equal(
      t.busyEvents.filter(Boolean).length,
      before,
      "metadata update must not claim busy",
    );
  } finally {
    t.unsub();
    // Drop the folder before the bridge dies: findSession routes
    // updates by sessionId across ALL registered folders, so a
    // killed-but-registered folder would keep matching later
    // tests' injects.
    await sessionManager
      .unregisterFolder(t.folder, "manual")
      .catch(() => undefined);
    t.bridge.child.kill("SIGTERM");
  }
});

test("pi-acp's startup banner on a fresh session never claims busy", async () => {
  const t = await setup("manual-agent.mjs", "banner");
  try {
    // Exactly what pi-acp does right after session/new: a live
    // agent_message_chunk with the pi version/skills banner,
    // sent out of turn on a session nobody has prompted yet.
    await t.inject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "pi v1.4.0\n---\n## Skills…" },
    });
    await t.inject({
      sessionUpdate: "plan",
      entries: [{ content: "still no user turn" }],
    });
    await sleep(150);

    // No user turn exists → no claim, ever. The old inference
    // stuck every fresh chat in busy forever on this shape.
    assert.equal(t.session.busy, false, "fresh session must not go busy");
    assert.equal(
      t.busyEvents.length,
      0,
      "no busy events for informational chunks on an unprompted session",
    );

    // The moment a user turn exists (replay pushes it, or a
    // prompt was sent), live activity is evidence again — the
    // Voir-restart-mid-turn recovery must keep working. A live
    // user_message_chunk lands the user turn without claiming
    // (claims happen before the message is appended), so the
    // NEXT chunk proves the gate opened.
    await t.inject({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "the interrupted turn's prompt" },
    });
    await t.inject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "still working…" },
    });
    assert(
      await until(() => t.session.busy && t.session.inferredBusy === true),
      "activity after a user turn must claim busy",
    );
  } finally {
    t.unsub();
    await sessionManager
      .unregisterFolder(t.folder, "banner")
      .catch(() => undefined);
    t.bridge.child.kill("SIGTERM");
  }
});

test("inference never claims busy while session/load is replaying", async () => {
  const t = await setup("manual-agent.mjs", "replay");
  try {
    // A user turn in the transcript (as a replayed transcript
    // would have) so the claim gate is open for the live chunk
    // after the load — that claim is the restart-recovery path
    // under test.
    await t.inject({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "the prompt that started the turn" },
    });
    const busyBefore = t.session.busy;

    await sessionManager
      .loadSession(t.folder, t.session.id, "replay")
      .catch(() => undefined);
    await sleep(50);

    // Chunks injected now (post-replay, live) SHOULD claim busy —
    // but a chunk that arrived inside the window must not have.
    assert.equal(
      t.busyEvents.length,
      0,
      "replay window leaked a busy event",
    );
    assert.equal(t.session.busy, busyBefore, "replay must not claim busy");

    // Post-replay live activity claims busy again (the fresh-load
    // / restart-recovery rehydration case).
    await t.inject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "live after load" },
    });
    assert(
      await until(() => t.session.busy && t.session.inferredBusy === true),
      "live chunk after replay must claim busy",
    );

    // A FAILED rebuild keeps the last evidence (the loadSession
    // success path is what clears; the manual fixture cannot
    // replay, so the claim survives a failed load).
    await sessionManager
      .loadSession(t.folder, t.session.id, "replay")
      .catch(() => undefined);
    await sleep(50);
    assert.ok(
      t.session.inferredBusy === true,
      "a failed rebuild must not silently drop the claim",
    );
  } finally {
    t.unsub();
    await sessionManager
      .unregisterFolder(t.folder, "replay")
      .catch(() => undefined);
    t.bridge.child.kill("SIGTERM");
  }
});