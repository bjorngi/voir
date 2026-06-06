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
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const sessionId = params.sessionId;
  const url = new URL(request.url);
  const folder = url.searchParams.get("folder");
  if (!folder) {
    return new Response("Missing ?folder=", { status: 400 });
  }
  const session = sessionManager.getSession(folder, sessionId);
  if (!session) {
    return new Response("Unknown session", { status: 404 });
  }

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

      // 3) Keep-alive every 15s so proxies don't drop the connection
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {}
      }, 15_000);

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

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
