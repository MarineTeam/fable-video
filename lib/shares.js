// Private per-recipient share links. Each share is a TTL-backed Redis record
// keyed by an unguessable id; an index set enables listing. Opening a link
// requires an Auth0 login whose email matches the intended recipient.
import crypto from "crypto";
import { k, redis } from "./redis";

export const DEFAULT_SHARE_HOURS = 72;
export const MAX_SHARE_HOURS = 720; // 30 days

// How much longer than a share's nominal expiresAt its Redis record is kept
// alive for. Deliberate design decision: "expired" is an app-level check
// against expiresAt (see isShareLive), not the Redis key's own physical TTL
// — otherwise Redis would hard-delete the record at the exact moment it
// expires, and an admin could never Extend an already-expired-but-not-
// revoked link (there is no cron/background job in this repo to resurrect
// a deleted key). Revoking a link still does an immediate, ungraced DEL —
// so "the record is gone" continues to mean exactly "revoked or fully past
// its grace window," and Extend naturally refuses both cases by finding
// nothing to extend.
const GRACE_SECONDS = 30 * 24 * 3600;

const indexKey = () => k("shares", "index");
const shareKey = (id) => k("share", id);

// True only for a share that both exists and has not passed its app-level
// expiresAt — the check every recipient-facing read must use instead of
// "the record exists," now that records outlive expiresAt by GRACE_SECONDS.
export function isShareLive(share) {
  return Boolean(share) && new Date(share.expiresAt).getTime() > Date.now();
}

export function isShareId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(id);
}

export function clampShareHours(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SHARE_HOURS;
  return Math.min(Math.max(Math.floor(n), 1), MAX_SHARE_HOURS);
}

export async function createShare({ videoId, videoTitle, email, hours, createdBy }) {
  const id = crypto.randomBytes(16).toString("base64url");
  const ttlHours = clampShareHours(hours);
  const now = Date.now();
  const share = {
    videoId,
    videoTitle,
    email,
    createdBy,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlHours * 3600 * 1000).toISOString(),
    // Page-load view tracking (link opened).
    viewCount: 0,
    firstViewedAt: null,
    lastViewedAt: null,
    // Real-playback tracking, driven by player.js events on the watch page.
    playCount: 0,
    furthestPercent: 0,
    completedAt: null,
    emailedAt: null,
    // Set when this share is swept into (or created as part of) a
    // recipient's bundle — see lib/bundles.js. Optional; absent on shares
    // that stand alone.
    bundleId: null,
  };
  const r = redis();
  await r.set(shareKey(id), share, { ex: ttlHours * 3600 + GRACE_SECONDS });
  await r.sadd(indexKey(), id);
  return { id, share };
}

// Creates one independently-revocable share per {videoId, email} pair — the
// cross product of the given videos and recipients. Each share is created
// via createShare, so each gets its own random id, its own TTL, and its own
// view/playback tracking, exactly like a single share.
export async function createShares(pairs, { hours, createdBy }) {
  return Promise.all(
    pairs.map(({ videoId, videoTitle, email }) =>
      createShare({ videoId, videoTitle, email, hours, createdBy })
    )
  );
}

export async function getShare(id) {
  if (!isShareId(id)) return null;
  return (await redis().get(shareKey(id))) || null;
}

// Patches a share record while preserving its remaining TTL (used to stamp
// viewedAt on first play and emailedAt on delivery).
export async function updateShare(id, patch) {
  if (!isShareId(id)) return null;
  const r = redis();
  const key = shareKey(id);
  const [share, ttl] = await Promise.all([r.get(key), r.ttl(key)]);
  if (!share || ttl <= 0) return null;
  const updated = { ...share, ...patch };
  await r.set(key, updated, { ex: ttl });
  return updated;
}

// Pure — computes the patch for a page-load "view" of a share's watch page.
// Every load counts, not just the first (unlike the old single viewedAt
// stamp), so the admin can see how many times a link was opened.
export function shareViewPatch(share) {
  const now = new Date().toISOString();
  return {
    viewCount: (share.viewCount || 0) + 1,
    firstViewedAt: share.firstViewedAt || share.viewedAt || now,
    lastViewedAt: now,
  };
}

// Pure — computes the patch for a real-playback event reported by the
// share-page player (see pages/api/share-track.js). "play" counts a
// playback start, a numeric percent raises the furthest-watched high-water
// mark, and "ended" marks the share as completed.
export function sharePlaybackPatch(share, { event, percent }) {
  const patch = {};
  if (event === "play") {
    patch.playCount = (share.playCount || 0) + 1;
  }
  if (typeof percent === "number" && Number.isFinite(percent)) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    patch.furthestPercent = Math.max(share.furthestPercent || 0, clamped);
  }
  if (event === "ended") {
    patch.completedAt = new Date().toISOString();
    patch.furthestPercent = 100;
  }
  return patch;
}

// Extends a share's expiry in place — same id/token/URL, no new link, no
// re-notification. Works "from now," not from the stale old expiry, so an
// already-app-expired-but-not-revoked share (still inside its grace window)
// can be extended back to live. Revoked shares have no record at all (revoke
// does an immediate DEL), so they naturally hit the not_found path here —
// extend can never double as a silent un-revoke.
export async function extendShare(id, hours) {
  if (!isShareId(id)) return { ok: false, error: "not_found" };
  const r = redis();
  const key = shareKey(id);
  const share = await r.get(key);
  if (!share) return { ok: false, error: "not_found" };

  const ttlHours = clampShareHours(hours);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  const updated = { ...share, expiresAt };
  await r.set(key, updated, { ex: ttlHours * 3600 + GRACE_SECONDS });
  return { ok: true, share: updated };
}

// All shares (live or grace-window-expired) addressed to one recipient —
// used to find "other already-active items" when a bundle is first created
// for someone (see lib/bundles.js's sweep-in behavior).
export async function listSharesForEmail(email) {
  const all = await listShares();
  return all.filter((s) => s.email === email);
}

export async function revokeShare(id) {
  if (!isShareId(id)) return false;
  const r = redis();
  const removed = await r.del(shareKey(id));
  await r.srem(indexKey(), id);
  return removed > 0;
}

export async function listShares() {
  const r = redis();
  const ids = (await r.smembers(indexKey())) || [];
  if (!ids.length) return [];
  const records = await r.mget(...ids.map((id) => shareKey(id)));
  const live = [];
  const dead = [];
  ids.forEach((id, i) => {
    const share = records[i];
    if (share) live.push({ id, ...share });
    else dead.push(id); // expired — prune from the index opportunistically
  });
  if (dead.length) {
    r.srem(indexKey(), ...dead).catch(() => {});
  }
  return live.sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));
}

export function shareUrl(req, id) {
  const base = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  if (base) return `${base}/watch/${id}`;
  const host = req?.headers?.host;
  return host ? `https://${host}/watch/${id}` : `/watch/${id}`;
}
