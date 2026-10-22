import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import webpush from "web-push";

/**
 * Web Push (RFC 8291 + VAPID RFC 8292) server plumbing.
 *
 * - VAPID keys come from env (`VOIR_VAPID_PUBLIC_KEY` /
 *   `VOIR_VAPID_PRIVATE_KEY`, generated once with
 *   `npx web-push generate-vapid-keys`). If either is missing the
 *   whole feature is off: the config endpoint reports
 *   `{ disabled: true }`, subscribe/test return 503, and the
 *   inbox seeds conversations without pushes. No silent
 *   failure in the send path — `sendPush` returns the delivery
 *   counts and callers log what happened.
 * - Subscriptions live in a JSON file (voir has no database;
 *   this is the same "durable state on the filesystem" approach
 *   as the timeline refs). Path: `$VOIR_DATA_DIR/push-subscriptions.json`,
 *   default `dev-data/`. The directory is NOT committed; in k8s
 *   this file needs a PVC mount (see docs/two-way.md Phase 3).
 *
 * Payloads are small by design (push services cap at 4 KB):
 * `{ title, body, url, tag }` — the notification deep-links into
 * the conversation; the content itself is fetched by the
 * already-authenticated tab after the tap, so nothing sensitive
 * rides through the push services.
 */

/** A PushSubscription as serialized by `pushManager.subscribe()`. */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** What we persist per device. `folders` is reserved for Phase 2
 * per-folder preferences; every subscription currently gets
 * everything ("*"). */
interface StoredSubscription extends PushSubscriptionJson {
  folders: string[] | "*";
  createdAt: number;
}

/** The JSON payload delivered (encrypted) to the service worker. */
export interface PushPayload {
  title: string;
  body: string;
  /** Path (or absolute URL) the notification opens on click. */
  url: string;
  /** OS-level grouping key: rapid follow-ups replace, not stack. */
  tag?: string;
  /** When set, the notification shows an inline-reply action
 * (messaging-app style) that POSTs back to the session. */
  folder?: string;
  sessionId?: string;
}

export function vapidPublicKey(): string | null {
  return process.env.VOIR_VAPID_PUBLIC_KEY || null;
}

export function pushEnabled(): boolean {
  return !!(process.env.VOIR_VAPID_PUBLIC_KEY && process.env.VOIR_VAPID_PRIVATE_KEY);
}

// -----------------------------------------------------------------------
// Registry (JSON file store)
// -----------------------------------------------------------------------

function registryPath(): string {
  return join(process.env.VOIR_DATA_DIR ?? "dev-data", "push-subscriptions.json");
}

async function loadRegistry(): Promise<StoredSubscription[]> {
  try {
    const raw = await readFile(registryPath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveRegistry(subs: StoredSubscription[]): Promise<void> {
  const dir = process.env.VOIR_DATA_DIR ?? "dev-data";
  await mkdir(dir, { recursive: true });
  await writeFile(registryPath(), JSON.stringify(subs, null, 2) + "\n");
}

export async function addSubscription(sub: PushSubscriptionJson): Promise<void> {
  const subs = await loadRegistry();
  // Idempotent: re-subscribes (pushsubscriptionchange, repeated
  // bell toggles) replace by endpoint instead of duplicating.
  const next: StoredSubscription = {
    endpoint: sub.endpoint,
    keys: sub.keys,
    folders: "*",
    createdAt: Date.now(),
  };
  const i = subs.findIndex((s) => s.endpoint === sub.endpoint);
  if (i === -1) subs.push(next);
  else subs[i] = next;
  await saveRegistry(subs);
}

export async function removeSubscription(endpoint: string): Promise<void> {
  const subs = await loadRegistry();
  const next = subs.filter((s) => s.endpoint !== endpoint);
  if (next.length !== subs.length) await saveRegistry(next);
}

export async function subscriptionCount(): Promise<number> {
  return (await loadRegistry()).length;
}

// -----------------------------------------------------------------------
// Sending
// -----------------------------------------------------------------------

let vapidConfigured = false;

function ensureVapid(): boolean {
  if (vapidConfigured) return true;
  const pub = process.env.VOIR_VAPID_PUBLIC_KEY;
  const priv = process.env.VOIR_VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails("mailto:voir@local", pub, priv);
  vapidConfigured = true;
  return true;
}

export interface PushResult {
  /** Subscriptions the payload was accepted for. */
  sent: number;
  /** Subscriptions that rejected delivery and were removed. */
  removed: number;
  /** Feature off (no VAPID keys): nothing was attempted. */
  disabled: boolean;
}

/**
 * Fan a payload out to every registered subscription. 404/410
 * responses from the push service mean the subscription is dead
 * (app uninstalled, permission revoked) — the entry is deleted
 * so a dead phone can never wedge a request. Other errors
 * (429 rate limit, 5xx) are logged but the subscription is
 * kept: those are transient.
 */
export async function sendPush(payload: PushPayload): Promise<PushResult> {
  if (!ensureVapid()) return { sent: 0, removed: 0, disabled: true };
  const subs = await loadRegistry();
  let sent = 0;
  let removed = 0;
  const removals: string[] = [];

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload));
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          removals.push(sub.endpoint);
          removed++;
        } else {
          console.warn(
            `[push] delivery to ${sub.endpoint.slice(0, 60)}… failed:`,
            status ?? (err as Error).message,
          );
        }
      }
    }),
  );

  if (removals.length > 0) {
    const keep = (await loadRegistry()).filter(
      (s) => !removals.includes(s.endpoint),
    );
    await saveRegistry(keep);
  }
  return { sent, removed, disabled: false };
}