/**
 * The Voir → supervisor proxy: preset ("fence command") switches.
 *
 * A supervisor-managed agent registers with supervisor awareness
 * (see bin/voir-supervisor.mjs): which preset launched it, the
 * catalog's preset names, and the daemon's loopback API
 * coordinates. This module consumes that bookkeeping — it
 * resolves the agent a caller points at and forwards the switch
 * to the supervisor's `PATCH /agents/<key>` on the agent's own
 * machine (loopback: supervisor and Voir share the host, the
 * only supported deployment today — see docs/supervisor.md).
 *
 * The raw preset commands never cross any API. Voir sees preset
 * names; the supervisor owns the commands and validates every
 * switch against its config catalog.
 *
 * Server-side only: the proxy carries the supervisor's bearer
 * token (when one is configured) and that must never leak into
 * any wire shape the browser sees — folderSummary deliberately
 * omits `supervisor` from FolderSummary.
 */
import { sessionManager } from "./sessions.server";
import type { FolderState } from "./sessions.server";

/** Bound the proxy call: a wedged supervisor must surface as an
 *  error the UI can show, not a hung request. */
const SWITCH_TIMEOUT_MS = 8_000;

export type SwitchPresetResult =
  | {
      ok: true;
      /** The supervisor's key for the agent (Voir's agentName). */
      name: string;
      /** The preset now desired. */
      preset: string;
      previous?: string;
      /** False when the agent already ran the requested preset. */
      changed: boolean;
    }
  | { ok: false; status: number; error: string; available?: string[] };

/**
 * Switch the preset (fence command) of an agent under `path`.
 * On success the supervisor has already persisted the desired
 * state and restarted the agent under the new command; Voir's
 * folder state catches up on the restarted agent's
 * re-registration, which also clears the switch caches.
 */
export async function switchAgentPreset(opts: {
  /** The worktree path (the registry key half Voir knows). */
  path: string;
  /** Preferred: resolve the agent that owns this chat. */
  sessionId?: string;
  /** Or the exact agent identity, when several share the path. */
  name?: string;
  /** The preset to switch to (a name from the catalog). */
  preset: string;
}): Promise<SwitchPresetResult> {
  const target = resolveTarget(opts);
  if (!target) {
    return {
      ok: false,
      status: 404,
      error: `No registered agent matches ${JSON.stringify(opts.path)}` +
        (opts.name ? ` with name ${JSON.stringify(opts.name)}` : "") +
        (opts.sessionId ? " / that sessionId" : ""),
    };
  }
  if (!target.supervisor || !target.preset) {
    return {
      ok: false,
      status: 409,
      error:
        "Agent is not supervisor-managed (one-shot acp-spawn has no preset to switch) — restart it with the command you want",
    };
  }

  const sup = target.supervisor;
  const key = target.agentName ?? "default";
  let res: Response;
  try {
    res = await fetch(
      `http://127.0.0.1:${sup.port}/agents/${encodeURIComponent(key)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(sup.token ? { Authorization: `Bearer ${sup.token}` } : {}),
        },
        body: JSON.stringify({ preset: opts.preset }),
        signal: AbortSignal.timeout(SWITCH_TIMEOUT_MS),
      },
    );
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `Supervisor unreachable on 127.0.0.1:${sup.port}: ${(err as Error).message}`,
    };
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error:
        typeof body.error === "string"
          ? body.error
          : `Supervisor refused the switch (${res.status})`,
      available: Array.isArray(body.available)
        ? (body.available.filter((x) => typeof x === "string") as string[])
        : undefined,
    };
  }
  if (typeof body.name !== "string" || typeof body.preset !== "string") {
    return { ok: false, status: 502, error: "Supervisor sent a malformed reply" };
  }
  // NOT patched into Voir's folder state here: the re-registration
  // the restarted agent's POST carries (within ~1s) is the switch
  // event's only honest detection point — that's where the switch
  // sweep clears the caches (see sessions.server.ts). The UI flips
  // its own label optimistically on this success.
  return {
    ok: true,
    name: body.name,
    preset: body.preset,
    previous: typeof body.previous === "string" ? body.previous : undefined,
    changed: body.changed !== false,
  };
}

/**
 * Resolve which agent the switch targets. Priority: by sessionId
 * (the agent that owns the open chat — unambiguous even when
 * several agents share the path), by explicit name, else the
 * unique agent under the path.
 */
function resolveTarget(opts: {
  path: string;
  sessionId?: string;
  name?: string;
}): FolderState | undefined {
  if (opts.sessionId) {
    const found = sessionManager.lookupSession(opts.path, opts.sessionId);
    if (found) return found.state;
    return undefined;
  }
  return sessionManager.getFolder(opts.path, opts.name);
}