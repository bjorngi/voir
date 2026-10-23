import type { Route } from "./+types/api.session-status";
import { sessionManager, activeSnapshot } from "~/lib/sessions.server";
import { sessionStatusStore } from "~/lib/session-status.server";

/**
 * Voir's own session-status API (docs/session-status.md) — the
 * membership overlay that `session/list` can't carry.
 *
 *   GET  /api/session-status
 *     → { sessions: ActivityRow[] }   the "Working on" snapshot,
 *       live-derived. This is the poll target for the root
 *       dashboard and the picker's active section.
 *
 *   POST /api/session-status
 *     { folder, sessionId, status: "active" | "archived" | "none" }
 *     → { ok: true }
 *       "none" = back to the pile (unstar). Setting active
 *       clears archived and vice versa.
 *
 * Deliberately separate from api.session-action.tsx: that
 * route proxies RPCs *to the agent* and 405s unknown kinds —
 * status is voir-local state, and conflating the two invites
 * the assumption that it round-trips through the agent.
 *
 * Note that createSession/sendMessage write `active` directly
 * (auto-activation, see sessions.server.ts); this route is the
 * manual surface: the star, the ✕, the archive button.
 */

export async function loader() {
  return { sessions: await activeSnapshot() };
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  let body: { folder?: unknown; sessionId?: unknown; status?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const folder = typeof body.folder === "string" ? body.folder : null;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  const status = body.status;
  if (!folder || !sessionId || !status) {
    return Response.json(
      { error: "folder, sessionId and status are required" },
      { status: 400 },
    );
  }
  if (status !== "active" && status !== "archived" && status !== "none") {
    return Response.json(
      { error: "status must be one of: active, archived, none" },
      { status: 400 },
    );
  }
  // One check covers unknown folder and unknown session: the
  // session must be held in memory (a listSessions stub counts
  // — every view that shows these buttons ran listSessions
  // first). No loading here; a session voir can't see is a 404.
  if (!sessionManager.lookupSession(folder, sessionId)) {
    return Response.json({ error: "Unknown folder/session" }, { status: 404 });
  }
  sessionStatusStore.setStatus(folder, sessionId, status);
  return Response.json({ ok: true });
}