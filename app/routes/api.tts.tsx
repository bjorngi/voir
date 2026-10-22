import type { Route } from "./+types/api.tts";
import { ttsConfig } from "~/lib/tts-server";

/**
 * GET /api/tts — what the client should narrate with. The client
 * picks its engine from this: "deepgram" = server-proxied neural
 * streaming TTS (WebSocket at the same path), "browser" = the
 * built-in speechSynthesis fallback. The key never leaves the
 * server either way.
 */
export async function loader(_args: Route.LoaderArgs) {
  return Response.json(ttsConfig());
}