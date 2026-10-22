import type { Route } from "./+types/api.session-meta";
import { sessionManager } from "~/lib/sessions.server";

/**
 * Returns metadata about a session: slash commands the agent has
 * advertised, and the model/mode lists + currently active model/mode.
 * The browser can read most of this from the chat loader, but this
 * endpoint exists for ad-hoc lookups (e.g. a future picker that
 * doesn't have a session in scope).
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const folder = url.searchParams.get("folder");
  const sessionId = params.sessionId;
  if (!folder) {
    return Response.json({ error: "Missing ?folder=" }, { status: 400 });
  }
  // Resolve the (folder, sessionId) pair to its owning agent — a
  // path can host several, and the metadata below (models, modes,
  // commands) is per-agent.
  const found = await sessionManager.findOrLoadSession(folder, sessionId);
  if (!found) {
    return Response.json({ error: "Unknown folder/session" }, { status: 404 });
  }
  const state = found.state;
  return {
    sessionId,
    commands: state.availableCommands,
    availableModels: state.availableModels,
    availableModes: state.availableModes,
    currentModeId: state.currentModeId,
    currentModelId: state.currentModelId,
  };
}
