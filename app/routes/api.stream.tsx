import type { Route } from "./+types/api.stream";
import { sessionManager } from "~/lib/sessions.server";

/**
 * Server-sent event stream of chat messages for a single ACP session.
 *
 * The browser connects with:
 *   /api/sessions/<sessionId>/stream?folder=<urlencoded-folder>
 *
 * Each event is a JSON-encoded `ChatMessage`. The current transcript
 * is replayed first as `snapshot` events, then a `ready` event, then
 * live updates as `message` events. The client uses the named events
 * to replace its initial state with the snapshot (which is the
 * authoritative transcript from the server) rather than appending
 * the snapshot on top of the SSR'd initial state.
 *
 * Connection failures are NOT reported as plain HTTP errors (the
 * browser's EventSource can't distinguish a 404 from a network
 * blip — both surface as an `error` event with no details). Instead
 * the endpoint always speaks SSE: when the folder or session can't
 * be served, the client receives a `fatal` event carrying a human-
 * readable reason, followed by stream end. The chat client keeps
 * retrying with backoff either way — e.g. a Voir restart means the
 * launcher's periodic re-registration will bring the folder back,
 * and an unknown session is rehydrated from the agent on the next
 * attempt — so `fatal` is informational, not terminal.
 */

const KEEP_ALIVE_INTERVAL_MS = 15_000;

export async function loader({ params, request }: Route.LoaderArgs) {
  const sessionId = params.sessionId;
  const url = new URL(request.url);
  const folder = url.searchParams.get("folder");
  if (!folder) {
    return new Response("Missing ?folder=", { status: 400 });
  }

  // Resolve the (folder, sessionId) pair to its agent: in-memory
  // fast path, replay of empty stubs, or a probe across every
  // agent registered under the folder path (Voir restart, open
  // tab, bookmarked URL).
  const found = await sessionManager.findOrLoadSession(folder, sessionId);
  if (!found) {
    return fatalStream(
      "Session not found on any agent under this folder — retrying…",
    );
  }
  const session = found.session;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        } catch {
          // controller already closed
        }
      };

      // 1) Replay the current transcript as snapshot events
      for (const m of session.messages) send("snapshot", m);

      // 2) Signal that the snapshot is done; the client should
      // switch to live mode after this.
      send("ready", {
        busy: session.busy,
      });

      // 3) Keep-alive every 15s so proxies don't drop the
      // connection. Sent as a named `ping` event (not a comment)
      // so the client can see it arrive: a connection that
      // stops delivering pings is dead even if the browser
      // hasn't noticed yet (half-open sockets on mobile
      // networks), and the client's watchdog reconnects.
      const keepAlive = setInterval(() => {
        send("ping", { t: Date.now() });
      }, KEEP_ALIVE_INTERVAL_MS);

      // 4) Subscribe to new messages
      const unsubscribe = sessionManager.subscribe(sessionId, (msg) => {
        send("message", msg);
      });

      const onAbort = () => {
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };
      request.signal.addEventListener("abort", onAbort);
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

/**
 * A one-shot SSE response that tells the client why the stream
 * can't be served right now, then ends. 200 + event rather than a
 * bare 404 so the EventSource gets structured information instead
 * of an ambiguous connection error.
 */
function fatalStream(message: string): Response {
  const body =
    `event: fatal\ndata: ${JSON.stringify({ message })}\n\n`;
  return new Response(body, { headers: sseHeaders() });
}

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  };
}