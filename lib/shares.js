// Private per-recipient share links. Each share is a TTL-backed Redis record
// keyed by an unguessable id; an index set enables listing. Opening a link
// requires an Auth0 login whose email matches the intended recipient.
import crypto from "crypto";
import { k, redis } from "./redis";

export const DEFAULT_SHARE_HOURS = 72;
export const MAX_SHARE_HOURS = 720; // 30 days

const indexKey = () => k("shares", "index");
const shareKey = (id) => k("share", id);

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
    viewedAt: null,
    emailedAt: null,
  };
  const r = redis();
  await r.set(shareKey(id), share, { ex: ttlHours * 3600 });
  await r.sadd(indexKey(), id);
  return { id, share };
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
