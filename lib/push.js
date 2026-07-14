// Web Push notifications. Inert until VAPID keys are configured
// (NEXT_PUBLIC_VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY) — everything below
// no-ops cleanly so the rest of the app is unaffected when push is off.
//
// Subscriptions are stored in one Redis hash keyed by the browser's push
// endpoint (unique per device), so a broadcast is a single HGETALL. Sends
// only ever go to endpoints whose owner is still an approved viewer or admin,
// and dead endpoints (HTTP 404/410) are pruned automatically.
import webpush from "web-push";
import { k, redis } from "./redis";
import { listViewers } from "./store";
import { adminEmails } from "./auth";

const env = (name) => (process.env[name] || "").trim();

// hash: endpoint -> { email, sub, addedAt }
const subsKey = () => k("push", "subs");
// set of video GUIDs already announced; sentinel so the first run doesn't
// blast a notification for the whole existing library.
const notifiedKey = () => k("push", "notified");
const seededKey = () => k("push", "seeded");

export function pushEnabled() {
  return Boolean(env("NEXT_PUBLIC_VAPID_PUBLIC_KEY") && env("VAPID_PRIVATE_KEY"));
}

let vapidReady = false;
function ensureVapid() {
  if (vapidReady) return true;
  if (!pushEnabled()) return false;
  // A VAPID subject must be a mailto: or https: URL; APP_BASE_URL is a valid
  // fallback when VAPID_SUBJECT isn't set explicitly.
  const subject = env("VAPID_SUBJECT") || env("APP_BASE_URL") || "https://example.com";
  webpush.setVapidDetails(
    subject,
    env("NEXT_PUBLIC_VAPID_PUBLIC_KEY"),
    env("VAPID_PRIVATE_KEY")
  );
  vapidReady = true;
  return true;
}

export async function savePushSubscription(email, subscription) {
  if (!subscription?.endpoint) return;
  await redis().hset(subsKey(), {
    [subscription.endpoint]: {
      email,
      sub: subscription,
      addedAt: new Date().toISOString(),
    },
  });
}

// Removes a subscription by endpoint. When an email is given, only removes it
// if it belongs to that user (so one viewer can't unsubscribe another).
export async function removePushSubscription(endpoint, email) {
  if (!endpoint) return false;
  const r = redis();
  if (email) {
    const rec = await r.hget(subsKey(), endpoint);
    if (rec && rec.email !== email) return false;
  }
  await r.hdel(subsKey(), endpoint);
  return true;
}

export async function listPushSubscriptions() {
  const all = (await redis().hgetall(subsKey())) || {};
  return Object.entries(all).map(([endpoint, rec]) => ({
    endpoint,
    email: rec?.email || null,
    sub: rec?.sub || null,
  }));
}

async function deliver(targets, payload) {
  if (!ensureVapid()) return { sent: 0, pruned: 0, configured: false };
  const body = JSON.stringify(payload);
  const dead = [];
  let sent = 0;
  await Promise.all(
    targets.map(async ({ endpoint, sub }) => {
      if (!sub) return;
      try {
        await webpush.sendNotification(sub, body);
        sent += 1;
      } catch (err) {
        // 404/410 mean the subscription is gone for good — prune it.
        if (err?.statusCode === 404 || err?.statusCode === 410) dead.push(endpoint);
      }
    })
  );
  if (dead.length) await redis().hdel(subsKey(), ...dead).catch(() => {});
  return { sent, pruned: dead.length, configured: true };
}

// Sends to every subscription whose owner is currently an approved viewer or
// an admin. Someone removed from the viewer list stops receiving, even if
// their old subscription record is still around.
export async function sendPushToApproved(payload) {
  if (!pushEnabled()) return { sent: 0, pruned: 0, configured: false };
  const [subs, viewers] = await Promise.all([
    listPushSubscriptions(),
    listViewers().catch(() => []),
  ]);
  const allowed = new Set([
    ...viewers.map((v) => v.email),
    ...adminEmails(),
  ]);
  const targets = subs.filter((s) => s.email && allowed.has(s.email));
  return deliver(targets, payload);
}

// Fire-once "new video" announcement. Given the already-mapped admin video
// list, announces any video that has newly become "ready". The first run
// seeds the notified set without sending (so existing videos aren't
// re-announced); the per-video SADD is atomic, so concurrent serverless
// instances never double-send.
export async function maybeAnnounceReadyVideos(videos) {
  if (!pushEnabled()) return;
  const r = redis();
  const ready = (videos || []).filter((v) => v.status === "ready" && v.id);

  const seeded = await r.get(seededKey());
  if (!seeded) {
    if (ready.length) await r.sadd(notifiedKey(), ...ready.map((v) => v.id));
    await r.set(seededKey(), "1");
    return;
  }

  const known = new Set((await r.smembers(notifiedKey())) || []);
  const fresh = ready.filter((v) => !known.has(v.id));
  for (const v of fresh) {
    const added = await r.sadd(notifiedKey(), v.id); // 1 only for the first caller
    if (added === 1) {
      await sendPushToApproved({
        title: "New video",
        body: v.title || "A new video is available",
        url: `/watch/video/${v.id}`,
      }).catch(() => {});
    }
  }
}
