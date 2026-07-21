// Redis-backed app state: settings, approved viewers, custom video order,
// theme, and per-viewer playback progress. All admin-editable live, no
// redeploy needed.
import { k, redis } from "./redis";

const DEFAULT_VIDEO_COUNT = 30;
export const MAX_VIDEO_COUNT = 100;

export async function getSettings() {
  const raw = (await redis().hgetall(k("settings"))) || {};
  const videoCount = Number(raw.videoCount);
  return {
    videoCount:
      Number.isFinite(videoCount) && videoCount > 0
        ? Math.min(Math.floor(videoCount), MAX_VIDEO_COUNT)
        : DEFAULT_VIDEO_COUNT,
  };
}

export async function saveSettings(patch) {
  await redis().hset(k("settings"), patch);
}

export async function getOrder() {
  const order = await redis().get(k("order"));
  return Array.isArray(order) ? order : [];
}

export async function saveOrder(ids) {
  await redis().set(k("order"), ids);
}

export async function pruneFromOrder(id) {
  const order = await getOrder();
  if (order.includes(id)) {
    await saveOrder(order.filter((existing) => existing !== id));
  }
}

export async function listViewers() {
  const r = redis();
  const [viewers, lastSeen] = await Promise.all([
    r.hgetall(k("viewers")),
    r.hgetall(k("lastseen")),
  ]);
  return Object.entries(viewers || {})
    .map(([email, meta]) => ({
      email,
      addedAt: meta?.addedAt || null,
      addedBy: meta?.addedBy || null,
      lastSeen: (lastSeen || {})[email] || null,
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

// Adds already-normalized emails; existing viewers keep their original
// addedAt. Returns how many were newly added.
export async function addViewers(emails, addedBy) {
  if (!emails.length) return 0;
  const r = redis();
  const existing = (await r.hgetall(k("viewers"))) || {};
  const fresh = emails.filter((email) => !(email in existing));
  if (fresh.length) {
    const now = new Date().toISOString();
    const payload = {};
    for (const email of fresh) payload[email] = { addedAt: now, addedBy };
    await r.hset(k("viewers"), payload);
  }
  return fresh.length;
}

export async function removeViewer(email) {
  const r = redis();
  await Promise.all([
    r.hdel(k("viewers"), email),
    r.hdel(k("lastseen"), email),
  ]);
}

export async function isApprovedViewer(email) {
  return Boolean(await redis().hexists(k("viewers"), email));
}

export async function stampLastSeen(email) {
  try {
    await redis().hset(k("lastseen"), { [email]: new Date().toISOString() });
  } catch {
    // Best-effort — never block the request over a last-seen stamp.
  }
}

export async function getProgress(email) {
  return (await redis().hgetall(k("progress", email))) || {};
}

export async function saveProgress(email, videoId, entry) {
  await redis().hset(k("progress", email), { [videoId]: entry });
}

export async function getTheme() {
  return (await redis().get(k("theme"))) || null;
}

export async function saveTheme(theme) {
  await redis().set(k("theme"), theme);
}

// Email watermark — global default. Layered with a per-video override, a
// per-share override, and a per-recipient exemption; see lib/watermark.js
// for how the layers combine.
export async function getWatermarkSettings() {
  const raw = (await redis().hgetall(k("settings"))) || {};
  return { enabled: raw.watermarkEnabled === true || raw.watermarkEnabled === "true" };
}

export async function saveWatermarkEnabled(enabled) {
  await redis().hset(k("settings"), { watermarkEnabled: Boolean(enabled) });
}

// Per-video watermark override ("on"/"off"), stored only when set — absence
// means "default" (fall through to the global setting).
export async function getVideoWatermarkOverrides() {
  return (await redis().hgetall(k("watermark", "videos"))) || {};
}

export async function getVideoWatermarkOverride(videoId) {
  const all = await getVideoWatermarkOverrides();
  return all[videoId] || "default";
}

export async function setVideoWatermarkOverride(videoId, mode) {
  const r = redis();
  if (mode === "default") {
    await r.hdel(k("watermark", "videos"), videoId);
  } else {
    await r.hset(k("watermark", "videos"), { [videoId]: mode });
  }
}

// Per-recipient exemption — any email here (viewer or admin) never sees a
// watermark, overriding every other layer.
export async function listWatermarkExemptions() {
  return ((await redis().smembers(k("watermark", "exempt"))) || []).sort();
}

export async function isWatermarkExempt(email) {
  return Boolean(await redis().sismember(k("watermark", "exempt"), email));
}

export async function setWatermarkExemption(email, exempt) {
  const r = redis();
  if (exempt) await r.sadd(k("watermark", "exempt"), email);
  else await r.srem(k("watermark", "exempt"), email);
}
