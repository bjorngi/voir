import type { Route } from "./+types/api.inbox";
import type { ChatMessage } from "~/lib/chat-types";
import { sendPush } from "~/lib/push.server";
import { sessionManager } from "~/lib/sessions.server";
import { sessionUrl } from "~/lib/urls";

/**
 * Machine-initiated conversations (docs/two-way.md, Mode 1).
 *
 *   POST /api/inbox        (auth: X-Voir-Token: $VOIR_INBOX_TOKEN)
 *   {
 *     "folder":  "/home/bjorn/code/infra",   // must be a registered folder
 *     "prompt":  "Summarize today's report.", // first user turn
 *     "from":    "cron/backup-check",        // optional origin marker
 *     "title":   "backup check",             // optional session title
 *     "notify":  "on-settle"                 // on-create | on-settle | both
 *   }
 *   → 201 { sessionId, folder, url }
 *
 * voir creates the session (ACP requires the client to do it),
 * sends the prompt as the first user turn prefixed with a
 * `[from: …]` origin marker, and pushes a Web Push notification so
 * a closed phone can tap straight into the conversation and reply
 * — the reply continues the same ACP session with full context.
 *
 * If VOIR_INBOX_TOKEN is unset the endpoint is off (503). Unlike
 * the design doc's "reject non-loopback requesters" fallback, a
 * web Request doesn't reliably expose the peer address, so we
 * don't pretend to be able to check it.
 *
 * `notify: "on-settle"` (the default) waits for the agent's turn
 * to finish and pushes the reply excerpt — "you have an answer
 * waiting". `on-create` pushes immediately so the user can watch
 * the turn stream live. Pushes are suppressed while a viewer has
 * the session's SSE stream open (listener count >1 = someone is
 * watching besides this watcher).
 */

const NOTIFY_MODES = ["on-create", "on-settle", "both"] as const;
type NotifyMode = (typeof NOTIFY_MODES)[number];

const EXCERPT_LEN = 140;

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const token = process.env.VOIR_INBOX_TOKEN;
  if (!token) {
    return Response.json(
      { error: "Inbox disabled: VOIR_INBOX_TOKEN is not set" },
      { status: 503 },
    );
  }
  if (request.headers.get("x-voir-token") !== token) {
    return Response.json({ error: "Invalid token" }, { status: 401 });
  }

  let body: {
    folder?: unknown;
    prompt?: unknown;
    title?: unknown;
    from?: unknown;
    notify?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const folder = typeof body.folder === "string" ? body.folder : null;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : null;
  if (!folder || !prompt) {
    return Response.json(
      { error: "Both 'folder' and 'prompt' are required" },
      { status: 400 },
    );
  }

  const notify: NotifyMode =
    typeof body.notify === "string" && (NOTIFY_MODES as readonly string[]).includes(body.notify)
      ? (body.notify as NotifyMode)
      : "on-settle";

  const state = sessionManager.getFolder(folder);
  if (!state) {
    return Response.json(
      { error: `Unknown folder ${folder}. Register it first (POST /api/folders).` },
      { status: 404 },
    );
  }

  const title = typeof body.title === "string" ? body.title : undefined;
  const from = typeof body.from === "string" && body.from.trim() ? body.from.trim() : null;

  // Create the session and seed the first user turn. The origin
  // marker makes provenance visible to both the user and pi.
  const session = await sessionManager.createSession(state.path, title);
  const text = from ? `[from: ${from}] ${prompt}` : prompt;
  sessionManager.sendMessage(state.path, session.id, [{ type: "text", text }]);

  const url = sessionUrl(state.path, session.id);

  if (notify === "on-create" || notify === "both") {
    void sendPush({
      title: `Voir — ${title ?? "new conversation"}`,
      body: excerpt(text),
      url,
      tag: `voir:${session.id}`,
      folder: state.path,
      sessionId: session.id,
    }).then((r) => logPush("on-create", r.sent, r.disabled));
  }

  if (notify === "on-settle" || notify === "both") {
    armSettlePush(state.path, session.id, title ?? defaultTitle());
  }

  return Response.json({ sessionId: session.id, folder: state.path, url }, { status: 201 });
}

/**
 * Watch the session for turn completion, then push the agent's
 * reply excerpt. Detaches on the first settle; if the folder or
 * session dies first ("Folder unregistered" error message), the
 * push just never fires — the inbox request already got its 201.
 */
function armSettlePush(folder: string, sessionId: string, title: string): void {
  const unsubscribe = sessionManager.subscribe(sessionId, (msg: ChatMessage) => {
    if (msg.kind === "busy" && msg.busy === false) {
      unsubscribe();
      // Count after our own removal: any remaining listener is a
      // live SSE viewer — the user is already watching this turn,
      // a push would be noise.
      if (sessionManager.listenerCount(sessionId) > 0) return;
      const session = sessionManager.getSession(folder, sessionId);
      const reply = lastAgentText(session?.messages ?? []);
      const res = sendPush({
        title: `Voir — ${title}`,
        body: reply ? excerpt(reply) : "The agent has replied.",
        url: sessionUrl(folder, sessionId),
        tag: `voir:${sessionId}`,
        folder,
        sessionId,
      });
      void res.then((r) => logPush("on-settle", r.sent, r.disabled));
      return;
    }
    if (msg.kind === "error") {
      // The turn errored (agent down, folder unregistered mid-turn).
      // Tell the user rather than leaving the notification missing.
      unsubscribe();
      if (sessionManager.listenerCount(sessionId) > 0) return;
      void sendPush({
        title: `Voir — ${title}`,
        body: `Turn failed: ${excerpt(msg.text ?? "unknown error")}`,
        url: sessionUrl(folder, sessionId),
        tag: `voir:${sessionId}`,
        folder,
        sessionId,
      }).then((r) => logPush("on-settle(error)", r.sent, r.disabled));
    }
  });
}

function lastAgentText(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "agent" && m.kind === "text" && m.text) return m.text;
  }
  return null;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_LEN ? flat.slice(0, EXCERPT_LEN - 1) + "…" : flat;
}

function logPush(mode: string, sent: number, disabled: boolean): void {
  if (disabled) {
    console.warn(`[inbox] push ${mode}: skipped (VOIR_VAPID_* not configured)`);
  } else {
    console.log(`[inbox] push ${mode}: delivered to ${sent} device(s)`);
  }
}

function defaultTitle(): string {
  return `inbox ${new Date().toISOString().slice(11, 16)}`;
}