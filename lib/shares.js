// Private per-recipient share links. Every share lives as one field of a
// single Redis HASH (fablevideo:shares, field = share id, value = the JSON
// record), using Redis 7.4's per-hash-field TTL (HEXPIRE/HSETEX family —
// Upstash supports these; confirmed via @upstash/redis's command bindings)
// instead of a physical TTL on its own standalone key. Opening a link
// requires an Auth0 login whose email matches the intended recipient.
//
// Why a hash instead of one Redis key per share (the pre-v1.13 design, one
// STRING key per id plus a SET index for listing): Upstash bills commands
// that take a list of *top-level keys* (MGET, MSET) per key, but a command
// that reads/writes multiple *fields of one hash* (HGETALL, HMGET, HSETEX,
// HDEL) is billed as a single command regardless of field count — because
// it only ever touches one key. Loading the admin Shares tab with 1000
// shares used to cost ~1001 commands (SMEMBERS + a 1000-key MGET); it now
// costs exactly 1 (HGETALL). Bulk revoke/unrevoke/delete/extend/resend of
// up to 100 ids now cost 2 commands each (one HMGET batch read, one
// HSETEX/HDEL batch write) instead of up to several hundred. See
// `getShares`/`writeShares` below — every bulk route in pages/api/admin/
// should go through these, never a Promise.all of per-id calls.
import crypto from "crypto";
import { k, redis } from "./redis";
import { clampWatermarkMode } from "./watermark";

export const DEFAULT_SHARE_HOURS = 72;
export const MAX_SHARE_HOURS = 720; // 30 days

// How much longer than a share's nominal expiresAt its hash field is kept
// alive for. Deliberate design decision: "expired" is an app-level check
// against expiresAt (see isShareLive), not the field's own physical TTL —
// otherwise Redis would drop the field at the exact moment it expires, and
// an admin could never Extend an already-expired-but-not-revoked link
// (there is no cron/background job in this repo to resurrect a dropped
// field). Revoking a link is a soft, in-place flag (see revokeShares) so it
// can be undone; isShareLive treats a revoked share as dead regardless of
// its record still existing. permanentlyDeleteShare(s) still does an
// immediate HDEL — so "the field is truly gone" continues to mean exactly
// that, and Extend refuses both a missing record and a revoked one by
// finding nothing extendable.
const GRACE_SECONDS = 30 * 24 * 3600;

// The single hash key every share record lives in. (Legacy pre-v1.13 data
// lived under k("share", id) STRING keys plus a k("shares","index") SET —
// see scripts/migrate-shares-to-hash.mjs, which must be run once against
// production before/at deploy to carry that data forward. Those old keys
// are never read by this module and are left in place, inert, exactly like
// the pvp:* keys from the 2026-07-09 prefix rename — see
// failure-archaeology FA-5 for why this module never auto-deletes them.)
const sharesKey = () => k("shares");

// Batch-reads specific fields of the shares hash in ONE command
// (HMGET is a single-key op — billed as 1 command regardless of how many
// ids are requested, unlike a top-level MGET). Returns { id: record|null }
// for every requested id, so callers never need a second read to know
// which ids were missing.
export async function getShares(ids) {
  if (!ids.length) return {};
  const result = await redis().hmget(sharesKey(), ...ids);
  if (!result) {
    // @upstash/redis's HMGET returns null (not an all-null object) when
    // every requested field is missing.
    return Object.fromEntries(ids.map((id) => [id, null]));
  }
  return result;
}

// Batch-writes several {id: record} pairs in ONE command (HSETEX — sets
// hash fields and their TTL together). `ttl` is either `{ ex: seconds }`
// (used whenever expiresAt itself is changing, so every written field gets
// the same freshly-computed physical TTL) or `{ keepttl: true }` (used
// whenever a patch leaves expiresAt untouched — each field keeps its own
// existing remaining TTL exactly, no read-back needed). The SDK nests both
// under an `expiration` key (`HSetExCommandOptions`), wrapped here so every
// call site can pass the flat shape.
async function writeShares(recordsById, ttl) {
  if (!Object.keys(recordsById).length) return;
  await redis().hsetex(sharesKey(), { expiration: ttl }, recordsById);
}

// True only for a share that both exists and has not passed its app-level
// expiresAt — the check every recipient-facing read must use instead of
// "the record exists," now that records outlive expiresAt by GRACE_SECONDS.
export function isShareLive(share) {
  return (
    Boolean(share) &&
    !share.revoked &&
    new Date(share.expiresAt).getTime() > Date.now()
  );
}

export function isShareId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(id);
}

export function clampShareHours(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SHARE_HOURS;
  return Math.min(Math.max(Math.floor(n), 1), MAX_SHARE_HOURS);
}

function buildShare({ videoId, videoTitle, email, ttlHours, now, watermark }) {
  return {
    videoId,
    videoTitle,
    email,
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
    // "default" | "on" | "off" — this link's layer in the watermark
    // resolution order; see lib/watermark.js.
    watermark: clampWatermarkMode(watermark),
    // Soft-revoke flag — see revokeShares/unrevokeShares below. A revoked
    // share keeps its full record (so an admin can inspect and restore it);
    // only permanentlyDeleteShare(s) actually removes it.
    revoked: false,
    revokedAt: null,
  };
}

export async function createShare({ videoId, videoTitle, email, hours, createdBy, watermark }) {
  const id = crypto.randomBytes(16).toString("base64url");
  const ttlHours = clampShareHours(hours);
  const now = Date.now();
  const share = { ...buildShare({ videoId, videoTitle, email, ttlHours, now, watermark }), createdBy };
  await writeShares({ [id]: share }, { ex: ttlHours * 3600 + GRACE_SECONDS });
  return { id, share };
}

// Creates one independently-revocable share per {videoId, email} pair — the
// cross product of the given videos and recipients — in ONE Redis command
// for the whole batch (HSETEX writing every field at once), since every
// pair in a single createShares call shares the same `hours` and therefore
// the same physical TTL. Each share still gets its own random id and its
// own independent view/playback tracking, exactly like a single share.
export async function createShares(pairs, { hours, createdBy, watermark }) {
  const ttlHours = clampShareHours(hours);
  const now = Date.now();
  const created = pairs.map(({ videoId, videoTitle, email }) => ({
    id: crypto.randomBytes(16).toString("base64url"),
    share: { ...buildShare({ videoId, videoTitle, email, ttlHours, now, watermark }), createdBy },
  }));
  if (created.length) {
    await writeShares(
      Object.fromEntries(created.map(({ id, share }) => [id, share])),
      { ex: ttlHours * 3600 + GRACE_SECONDS }
    );
  }
  return created;
}

export async function getShare(id) {
  if (!isShareId(id)) return null;
  return (await redis().hget(sharesKey(), id)) || null;
}

// Patches a single share record, preserving its remaining physical TTL
// exactly (HSETEX ... KEEPTTL — no read-back of the current TTL needed).
// Used for high-frequency, single-id, non-admin touches: the watch page's
// view stamp and the playback-tracking endpoint. Bulk admin actions should
// use getShares + writeShares directly instead (see revokeShares etc.
// below) rather than looping this per id.
export async function updateShare(id, patch) {
  if (!isShareId(id)) return null;
  const share = await getShare(id);
  if (!share) return null;
  const updated = { ...share, ...patch };
  await writeShares({ [id]: updated }, { keepttl: true });
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
// can be extended back to live. A revoked share still has a record (soft
// revoke, see revokeShares below), but extend must never double as a
// silent un-revoke — it's refused explicitly, restore it first. Every
// caller (single-id or bulk, pages/api/admin/share-extend.js) goes through
// this bulk form — one HMGET (batch read) + one HSETEX (batch write) no matter
// how many ids are passed, instead of a get+set per id. Every id in one
// call shares the same `hours`, so every extended share lands on the exact
// same new expiresAt and therefore the exact same new physical TTL — no
// approximation needed, unlike revokeShares/unrevokeShares below (which use
// KEEPTTL instead, for the same reason: exactness without a batch-wide
// read of each id's individual remaining TTL).
export async function extendShares(ids, hours) {
  const found = await getShares(ids);
  const ttlHours = clampShareHours(hours);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  const results = {};
  const toWrite = {};
  for (const id of ids) {
    const share = found[id];
    if (!share) {
      results[id] = { ok: false, error: "not_found" };
      continue;
    }
    if (share.revoked) {
      results[id] = { ok: false, error: "revoked" };
      continue;
    }
    const updated = { ...share, expiresAt };
    toWrite[id] = updated;
    results[id] = { ok: true, share: updated };
  }
  if (Object.keys(toWrite).length) {
    await writeShares(toWrite, { ex: ttlHours * 3600 + GRACE_SECONDS });
  }
  return results;
}

// All shares (live or grace-window-expired) addressed to one recipient —
// used to find "other already-active items" when a bundle is first created
// for someone (see lib/bundles.js's sweep-in behavior).
export async function listSharesForEmail(email) {
  const all = await listShares();
  return all.filter((s) => s.email === email);
}

// Soft revoke — flags the share as revoked in place instead of deleting it,
// so an admin can later undo an accidental revoke via unrevokeShares without
// minting a new link. isShareLive treats a revoked share as dead immediately
// (recipient access stops right away); the record itself just keeps living
// out its existing grace-window TTL like any other share (KEEPTTL — each
// field's own remaining TTL is preserved exactly, untouched by this write).
// Every caller (single-id or bulk, pages/api/admin/shares.js) goes through
// this bulk form — one HMGET + one HSETEX(KEEPTTL) regardless of id count.
// Revoking an id that's missing or already revoked is still reported as
// "ok" (idempotent — matches the pre-existing single-id behavior, where the
// route never actually inspected the boolean return value either).
export async function revokeShares(ids) {
  const found = await getShares(ids);
  const now = new Date().toISOString();
  const toWrite = {};
  const results = {};
  for (const id of ids) {
    const share = found[id];
    if (!share) {
      results[id] = { ok: true, share: null };
      continue;
    }
    const updated = { ...share, revoked: true, revokedAt: now };
    toWrite[id] = updated;
    results[id] = { ok: true, share: updated };
  }
  if (Object.keys(toWrite).length) await writeShares(toWrite, { keepttl: true });
  return results;
}

// Undoes a soft revoke — same id/URL, no new link. Only applies to a share
// that's still revoked; a share that was never revoked, or one already
// permanently deleted, comes back as an explicit error rather than silently
// no-op'ing. Every caller (single-id or bulk) goes through this bulk form —
// one HMGET + one HSETEX(KEEPTTL) regardless of id count.
export async function unrevokeShares(ids) {
  const found = await getShares(ids);
  const results = {};
  const toWrite = {};
  for (const id of ids) {
    const share = found[id];
    if (!share) {
      results[id] = { ok: false, error: "not_found" };
      continue;
    }
    if (!share.revoked) {
      results[id] = { ok: false, error: "not_revoked" };
      continue;
    }
    const updated = { ...share, revoked: false, revokedAt: null };
    toWrite[id] = updated;
    results[id] = { ok: true, share: updated };
  }
  if (Object.keys(toWrite).length) await writeShares(toWrite, { keepttl: true });
  return results;
}

// The old, ungraced revoke behavior — an immediate, irreversible HDEL. Used
// to permanently remove a share that's already been soft-revoked (or any
// share an admin wants gone for good), never as the default revoke action.
// One HMGET (only to surface each deleted share's video/recipient for the
// audit-log detail) + one HDEL (multi-field delete in a single command)
// regardless of id count.
export async function permanentlyDeleteShares(ids) {
  if (!ids.length) return {};
  const found = await getShares(ids);
  await redis().hdel(sharesKey(), ...ids);
  const results = {};
  ids.forEach((id) => {
    results[id] = { ok: true, share: found[id] || null };
  });
  return results;
}

// Bulk-stamps a patch (e.g. { emailedAt }) onto share records the caller
// ALREADY has in memory — zero reads, one HSETEX(KEEPTTL) write. Used by
// the create/resend routes right after a send succeeds, instead of looping
// updateShare (which would re-read each record it already has).
export async function stampShares(recordsById, patch) {
  const toWrite = Object.fromEntries(
    Object.entries(recordsById).map(([id, share]) => [id, { ...share, ...patch }])
  );
  await writeShares(toWrite, { keepttl: true });
  return toWrite;
}

export async function listShares() {
  // HGETALL is a single-key command — billed as 1 regardless of how many
  // fields (shares) the hash holds. Redis's native per-field TTL means an
  // expired share's field is simply absent here already; no app-level
  // dead-id pruning is needed anymore (the old index-set design needed an
  // opportunistic SREM pass for this — see git history for that shape).
  const all = await redis().hgetall(sharesKey());
  if (!all) return [];
  return Object.entries(all)
    .map(([id, share]) => ({ id, ...share }))
    .sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));
}

// Rolls up existing per-share view/playback tracking by video — no new
// tracking, just an aggregation of fields already stored on each share
// record (see shareViewPatch/sharePlaybackPatch above). Used by the admin
// Analytics tab's per-video panel.
export function rollupShareAnalyticsByVideo(shares) {
  const byVideo = new Map();
  for (const share of shares) {
    if (!byVideo.has(share.videoId)) {
      byVideo.set(share.videoId, {
        videoId: share.videoId,
        videoTitle: share.videoTitle,
        shares: 0,
        recipients: new Set(),
        views: 0,
        started: 0,
        completed: 0,
        progressSum: 0,
      });
    }
    const agg = byVideo.get(share.videoId);
    agg.shares += 1;
    agg.recipients.add(share.email);
    agg.views += share.viewCount || 0;
    if ((share.playCount || 0) > 0) agg.started += 1;
    if (share.completedAt) agg.completed += 1;
    agg.progressSum += share.furthestPercent || 0;
  }
  return Array.from(byVideo.values())
    .map((agg) => ({
      videoId: agg.videoId,
      videoTitle: agg.videoTitle,
      shares: agg.shares,
      uniqueRecipients: agg.recipients.size,
      views: agg.views,
      started: agg.started,
      completed: agg.completed,
      completionRate: agg.shares ? Math.round((agg.completed / agg.shares) * 100) : 0,
      avgProgress: agg.shares ? Math.round(agg.progressSum / agg.shares) : 0,
    }))
    .sort((a, b) => b.shares - a.shares);
}

export function shareUrl(req, id) {
  const base = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  if (base) return `${base}/watch/${id}`;
  const host = req?.headers?.host;
  return host ? `https://${host}/watch/${id}` : `/watch/${id}`;
}
