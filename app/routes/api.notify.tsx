import type { Route } from "./+types/api.notify";
import {
  addSubscription,
  pushEnabled,
  removeSubscription,
  sendPush,
  subscriptionCount,
  vapidPublicKey,
  type PushSubscriptionJson,
} from "~/lib/push.server";
import { folderUrl, sessionUrl } from "~/lib/urls";

/**
 * Client-facing Web Push endpoints (the phone's browser is the
 * caller; all same-origin, no token — CSRF-safe via Origin check).
 *
 *   GET  /api/notify/config       → { publicKey } | { disabled: true }
 *   POST /api/notify/subscribe    → 201  body: PushSubscription JSON
 *   POST /api/notify/unsubscribe  → 204  body: { endpoint }
 *   POST /api/notify/test         → 204  body: { url?, text? } (dev aid)
 *
 * Named /api/notify rather than the /api/push/* from the design
 * doc because /api/push is taken by the git-push endpoint.
 */

export async function loader() {
  return Response.json(
    pushEnabled() ? { publicKey: vapidPublicKey() } : { disabled: true },
  );
}

export async function action({ request }: Route.ActionArgs) {
  if (!originAllowed(request)) {
    return Response.json({ error: "Cross-origin not allowed" }, { status: 403 });
  }

  const name = new URL(request.url).pathname.replace(/^.*\/notify\//, "");
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  if (!pushEnabled()) {
    return Response.json(
      { error: "Push disabled: VOIR_VAPID_* keys are not configured" },
      { status: 503 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // empty body is fine for /test
  }

  if (name === "subscribe") {
    const sub = body as unknown as PushSubscriptionJson;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys.auth) {
      return Response.json(
        { error: "Invalid PushSubscription payload" },
        { status: 400 },
      );
    }
    await addSubscription(sub);
    return Response.json({ ok: true, devices: await subscriptionCount() }, { status: 201 });
  }

  if (name === "unsubscribe") {
    const endpoint = body.endpoint;
    if (typeof endpoint !== "string") {
      return Response.json({ error: "Missing endpoint" }, { status: 400 });
    }
    await removeSubscription(endpoint);
    return new Response(null, { status: 204 });
  }

  if (name === "test") {
    // Deliberately tolerant: fire a harmless push so the curl
    // recipe in docs/two-way.md works without any auth. Deep-links
    // into the chat when folder (and optionally sessionId) is
    // given, mirroring what the inbox's real pushes carry.
    const text = typeof body.text === "string" ? body.text : undefined;
    const explicitUrl = typeof body.url === "string" ? body.url : undefined;
    const folder = typeof body.folder === "string" ? body.folder : undefined;
    const sessionId =
      typeof body.sessionId === "string" ? body.sessionId : undefined;
    let url = "/";
    if (explicitUrl) url = explicitUrl;
    else if (folder && sessionId) url = sessionUrl(folder, sessionId);
    else if (folder) url = folderUrl(folder);
    const res = await sendPush({
      title: "Voir — test notification",
      body: text ?? "Notifications are working. 🔔",
      url,
      tag: "voir:test",
      folder,
      sessionId,
    });
    if (res.disabled) {
      return Response.json({ error: "Push disabled" }, { status: 503 });
    }
    console.log(
      `[push] test fired: sent=${res.sent} removed=${res.removed} ` +
        `(registry has ${await subscriptionCount()} device(s))`,
    );
    return Response.json({ sent: res.sent, removed: res.removed });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

/**
 * CSRF guard for same-origin endpoints: browsers always attach an
 * Origin header to cross-site POSTs, so a present-and-mismatched
 * Origin is a cross-site call and gets rejected. An absent Origin
 * (curl, server-side callers) is allowed — these endpoints hold
 * no secrets and are harmless without the VAPID private key.
 */
function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}