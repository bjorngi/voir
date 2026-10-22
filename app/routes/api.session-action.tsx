import type { Route } from "./+types/api.session-action";
import { sessionManager } from "~/lib/sessions.server";

/**
 * Dispatch a session-scoped action to the underlying ACP agent.
 *
 *   POST /api/sessions/:sessionId/action
 *   { "folder": "<abs>", "kind": "set_mode" | "set_model" | "cancel", "value"?: "<id>" }
 *
 * `kind`:
 *   - "set_mode"  → session/set_mode   (value = modeId, required)
 *   - "set_model" → session/set_model  (value = modelId, required)
 *                   Marked UNSTABLE in the SDK schema — ACP has
 *                   no stable model field yet. The agent returns
 *                   `{}` on success and does NOT broadcast
 *                   `current_model_update`; clients must update
 *                   locally from the response.
 *   - "cancel"    → session/cancel     (no value)
 *
 * The route exists so the chat UI has a single well-known endpoint
 * for all session-scoped RPCs.
 */
export async function action({ params, request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  let body: { folder?: string; kind?: string; value?: string; text?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.folder || !body.kind) {
    return Response.json(
      { error: "folder and kind are required" },
      { status: 400 },
    );
  }
  const folder = body.folder;
  const sessionId = params.sessionId;
  try {
    if (body.kind === "set_mode") {
      if (typeof body.value !== "string" || !body.value) {
        return Response.json(
          { error: "value is required for set_mode" },
          { status: 400 },
        );
      }
      await sessionManager.setMode(folder, sessionId, body.value);
      return Response.json({ ok: true, currentModeId: body.value });
    }
    if (body.kind === "set_model") {
      if (typeof body.value !== "string" || !body.value) {
        return Response.json(
          { error: "value is required for set_model" },
          { status: 400 },
        );
      }
      await sessionManager.setModel(folder, sessionId, body.value);
      return Response.json({ ok: true, currentModelId: body.value });
    }
  if (body.kind === "send") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        return Response.json(
          { error: "text is required for send" },
          { status: 400 },
        );
      }
      // Fire-and-forget like the composer: runPrompt drives the
      // busy/settle broadcasts; the caller (the service worker's
      // inline reply) just needs the turn accepted.
      sessionManager.sendMessage(folder, sessionId, [
        { type: "text", text },
      ]);
      return Response.json({ ok: true });
    }
    if (body.kind === "cancel") {
      sessionManager.cancel(folder, sessionId);
      return Response.json({ ok: true });
    }
    return Response.json(
      { error: `Unknown kind: ${body.kind}` },
      { status: 400 },
    );
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
