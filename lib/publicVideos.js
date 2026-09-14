// Public (no-login) links for one video at a time.
//
// This inverts the portal's founding assumption — every other path requires a
// session — so the shape here is deliberately the most conservative one that
// still does the job:
//
//  * DEFAULT DENY, EXPLICITLY. A video is public only when a row exists for
//    it. "Public" is never inferred from a missing setting, a falsy value, or
//    a parse failure. `isPublicVideo` returns true for exactly one reason.
//
//  * FAILS CLOSED ON A REDIS ERROR. This is the OPPOSITE of the schedule
//    (lib/schedule.js), which fails open, and it is deliberate: a schedule
//    decides *when* already-entitled people see content, so an unreadable one
//    must not take the library off the air. This flag decides whether the
//    whole internet sees a video, so an unreadable one must not publish it.
//    A public link briefly returning 404 during an outage beats publishing
//    the library during an outage. Every failure path below lands on "not
//    public".
//
//  * ONE VIDEO, NOTHING ELSE. Nothing here can enumerate the library for an
//    anonymous caller. `listPublicVideoIds` exists for the ADMIN panel only.
//
// Groups are irrelevant to this flag by construction: they narrow a *viewer's*
// access, and a public visitor is not a viewer. Schedules are NOT irrelevant —
// see pages/watch/public/[id].js, which still enforces the publish window.
import { k, redis } from "./redis";

const publicKey = () => k("public");

function videoId(id) {
  return String(id || "").trim();
}

// The single question the public route asks. Returns true ONLY when a row
// exists; false for absence, for a blank id, and for any Redis failure.
export async function isPublicVideo(id) {
  const key = videoId(id);
  if (!key) return false;
  try {
    return Boolean(await redis().hexists(publicKey(), key));
  } catch (err) {
    // Fail closed. See the header: an infra error must never publish.
    console.error("Could not check whether a video is public:", err);
    return false;
  }
}

// Admin-panel reads. These are allowed to throw — the caller is an
// authenticated admin route that answers 502, not a public page.
export async function getPublicMap() {
  const raw = (await redis().hgetall(publicKey())) || {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    out[id] = {
      enabledAt: value?.enabledAt || null,
      enabledBy: value?.enabledBy || null,
    };
  }
  return out;
}

export async function listPublicVideoIds() {
  return Object.keys(await getPublicMap());
}

export async function setPublicVideo(id, admin) {
  const key = videoId(id);
  if (!key) return null;
  const record = { enabledAt: new Date().toISOString(), enabledBy: admin || null };
  await redis().hset(publicKey(), { [key]: record });
  return record;
}

export async function unsetPublicVideo(id) {
  const key = videoId(id);
  if (!key) return;
  await redis().hdel(publicKey(), key);
}

// Called when a video is deleted, alongside the order/group/schedule/meta
// prunes. Leaving a stale row would mean a recycled bunny.net id inherits a
// public grant — the worst direction for this particular flag to leak in.
export async function prunePublicVideo(id) {
  await unsetPublicVideo(id);
}

// The canonical public URL for a video. Returns null when APP_BASE_URL isn't
// configured, so the admin UI can say "set APP_BASE_URL" rather than render a
// broken half-link.
export function publicVideoUrl(id) {
  const base = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  const key = videoId(id);
  if (!base || !key) return null;
  return `${base}/watch/public/${encodeURIComponent(key)}`;
}
