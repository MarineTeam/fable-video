// Redis-backed app state: settings, approved viewers, custom video order,
// theme, and per-viewer playback progress. All admin-editable live, no
// redeploy needed.
import { k, redis } from "./redis";
import { RECOUNT_SCRIPT, VOTE_SCRIPT } from "./ratingScripts";
import { resolveSiteName } from "./siteName";
import { ICON_SIZES } from "./appIcon";
import crypto from "crypto";
import { MAX_PROGRESS_ENTRIES, progressToEvict } from "./progress";

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
    siteName: resolveSiteName(raw.siteName),
  };
}

// The portal's display name, needed by every page's title and header. A
// single-field read rather than getSettings()'s HGETALL, because most callers
// want only this and it runs on every server-rendered page.
//
// Callers should treat a throw as "use the default": a name is cosmetic, and
// an unreadable one must never take a page down. resolveSiteName(null) gives
// the env value or the built-in default.
// Admin-set app icons (lib/appIcon.js validates them). One hash:
//   k("app_icon")  version -> "v<hex>", s180/s192/s512 -> base64 PNG
// The version is written LAST and cleared FIRST, so a reader that sees a
// version always finds the whole set behind it. It is prefixed with a letter
// because Upstash JSON-parses stored strings where it can: an all-digit hex
// version would come back as a number, and a long one would lose precision.
export async function getAppIconVersion() {
  const v = await redis().hget(k("app_icon"), "version");
  return typeof v === "string" && /^v[0-9a-f]{12}$/.test(v) ? v : null;
}

export async function getAppIcon(size) {
  if (!ICON_SIZES.includes(size)) return null;
  const r = redis();
  const [version, data] = await Promise.all([
    r.hget(k("app_icon"), "version"),
    r.hget(k("app_icon"), `s${size}`),
  ]);
  if (!version || typeof data !== "string" || !data) return null;
  return { version: String(version), bytes: Buffer.from(data, "base64") };
}

// `icons` is validateIconSet()'s output: { size: Buffer }. One write per size
// keeps each Upstash request small.
export async function setAppIcons(icons) {
  const r = redis();
  const hash = crypto.createHash("sha256");
  for (const size of ICON_SIZES) hash.update(icons[size]);
  const version = `v${hash.digest("hex").slice(0, 12)}`;
  await r.hdel(k("app_icon"), "version");
  for (const size of ICON_SIZES) {
    await r.hset(k("app_icon"), { [`s${size}`]: icons[size].toString("base64") });
  }
  await r.hset(k("app_icon"), { version });
  return version;
}

export async function clearAppIcons() {
  const r = redis();
  await r.hdel(k("app_icon"), "version");
  await r.del(k("app_icon"));
}

export async function getSiteName() {
  const stored = await redis().hget(k("settings"), "siteName");
  return resolveSiteName(stored);
}

// Storing a name equal to the env/default resolution still writes it — an
// admin who types the current name explicitly has expressed a choice, and
// silently dropping it would make the field feel broken.
export async function saveSiteName(name) {
  await redis().hset(k("settings"), { siteName: String(name).trim() });
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
      tags: Array.isArray(meta?.tags) ? meta.tags : [],
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

// Adds already-normalized emails; existing viewers keep their original
// addedAt. Returns how many were newly added.
// `tags`, when given, is written in the SAME record as the approval. That is
// what lets a group-scoped caller approve someone straight into a restricted
// group: two writes would leave a window — or, after a crash, a permanent
// state — in which the new viewer is in no group and sees the whole library.
export async function addViewers(emails, addedBy, { tags } = {}) {
  if (!emails.length) return 0;
  const r = redis();
  const existing = (await r.hgetall(k("viewers"))) || {};
  const fresh = emails.filter((email) => !(email in existing));
  if (fresh.length) {
    const now = new Date().toISOString();
    const payload = {};
    for (const email of fresh) {
      payload[email] = Array.isArray(tags) && tags.length ? { addedAt: now, addedBy, tags: [...tags] } : { addedAt: now, addedBy };
    }
    await r.hset(k("viewers"), payload);
  }
  return fresh.length;
}

// Overwrites the tag list for an existing viewer (e.g. "Team A") — used to
// target bulk-share recipients by group instead of pasting emails each time.
// Returns false if the email isn't an approved viewer.
export async function setViewerTags(email, tags) {
  const r = redis();
  const existing = await r.hget(k("viewers"), email);
  if (!existing) return false;
  const cleaned = Array.from(
    new Set(
      (Array.isArray(tags) ? tags : [])
        .map((t) => String(t).trim())
        .filter(Boolean)
    )
  ).sort();
  await r.hset(k("viewers"), { [email]: { ...existing, tags: cleaned } });
  return true;
}

export async function removeViewer(email) {
  const r = redis();
  await Promise.all([
    r.hdel(k("viewers"), email),
    r.hdel(k("lastseen"), email),
  ]);
}

// The stored record for one viewer (addedAt/addedBy/tags), or null if they
// are not on the viewer list. Group scoping reads tags through this.
export async function getViewerMeta(email) {
  const meta = await redis().hget(k("viewers"), email);
  if (!meta) return null;
  return {
    addedAt: meta?.addedAt || null,
    addedBy: meta?.addedBy || null,
    tags: Array.isArray(meta?.tags) ? meta.tags : [],
  };
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

// Saves one video's position, in one command on the common path: the script
// writes when the video already has an entry or the hash is under the cap, and
// otherwise answers 0 WITHOUT writing. Only then — a new video at the cap —
// does this read the hash, drop the least recently watched entries, and write.
// That slow path is not atomic with the check, so two first-time saves racing
// at the cap can leave the hash one or two over it; the next save trims it back.
// See lib/progress.js for why the cap exists.
const SAVE_PROGRESS_SCRIPT = `
if redis.call("HEXISTS", KEYS[1], ARGV[1]) == 1 or redis.call("HLEN", KEYS[1]) < tonumber(ARGV[3]) then
  redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
  return 1
end
return 0
`;

export async function saveProgress(email, videoId, entry) {
  const r = redis();
  const key = k("progress", email);
  const value = JSON.stringify(entry);
  const saved = await r.eval(SAVE_PROGRESS_SCRIPT, [key], [videoId, value, String(MAX_PROGRESS_ENTRIES)]);
  if (Number(saved) === 1) return;
  const evict = progressToEvict((await r.hgetall(key)) || {}, MAX_PROGRESS_ENTRIES);
  if (evict.length) await r.hdel(key, ...evict);
  await r.hset(key, { [videoId]: entry });
}

// "My list" — the per-viewer saved queue. Deliberately a SIBLING of the
// progress hash above rather than a field inside it: progress is derived from
// playback and written on a timer, this is written only by an explicit click,
// and merging them would make one viewer's saved list vulnerable to a
// progress write racing it.
export async function getMyList(email) {
  return (await redis().hgetall(k("mylist", email))) || {};
}

export async function saveToMyList(email, videoId) {
  await redis().hset(k("mylist", email), { [videoId]: Date.now() });
}

export async function removeFromMyList(email, videoId) {
  await redis().hdel(k("mylist", email), videoId);
}

// Ratings. Two keys, and the split is explained in lib/ratings.js: the vote
// lives under the VIEWER's key, beside their progress and saved list, and the
// counters hold no identity at all. (Nothing deletes any of those three when
// a viewer is removed — removeViewer above clears only the viewer record and
// last-seen time. That is a known gap in FEATURES.md, not a property.)
export async function getRatings(email) {
  return (await redis().hgetall(k("ratings", email))) || {};
}

// Sets ("up" / "down") or clears (null) one viewer's vote AND moves the
// counters, as one Redis script — see lib/ratingScripts.js. There is no
// separate counter write left to fail, so the totals cannot drift from the
// votes the way the old best-effort HINCRBY could. Returns whether anything
// changed; a repeated vote is a no-op decided inside the script, so two
// racing clicks cannot both count.
export async function recordRating(email, videoId, vote) {
  const changed = await redis().eval(
    VOTE_SCRIPT,
    [k("ratings", email), k("rating_counts")],
    [videoId, vote || ""]
  );
  return Number(changed) === 1;
}

export async function getRatingCounts() {
  return (await redis().hgetall(k("rating_counts"))) || {};
}

// Every viewer's ratings hash, by SCAN. Used only by the admin recount, which
// is an occasional maintenance action — the same exception the stale-bundle
// cleanup makes to "look up by pointer, not by scanning" (lib/bundles.js).
export async function scanRatingKeys() {
  const r = redis();
  const pattern = `${k("ratings", "")}*`;
  let cursor = "0";
  const keys = [];
  do {
    const [next, batch] = await r.scan(cursor, { match: pattern, count: 200 });
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

// Rebuilds the counters from the votes and replaces them. Corrects drift left
// by the old two-write path and anything else that ever skewed a total.
export async function recountRatings() {
  const keys = await scanRatingKeys();
  const [votes, fields] = await redis().eval(RECOUNT_SCRIPT, [k("rating_counts"), ...keys], []);
  return { viewers: keys.length, votes: Number(votes) || 0, fields: Number(fields) || 0 };
}

// Called when a video is deleted, so the counters never accumulate totals for
// videos that no longer exist — and a recycled bunny.net id cannot inherit
// another video's score. The per-viewer votes are left alone: they are keyed
// by a video id that no longer resolves, so they read as nothing, and rewriting
// every viewer's hash on a delete would be a scan this repo does not do.
export async function clearVideoRatingCounts(videoId) {
  await redis().hdel(k("rating_counts"), `${videoId}:up`, `${videoId}:down`);
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

// Whether the per-subscriber podcast feed is served at all.
//
// Defaults to OFF, which is the opposite polarity from the other additive
// features in this repo (a video with no schedule is visible; a viewer in no
// group is unrestricted). That is deliberate: those defaults are additive
// because their absence must not HIDE content, whereas this one widens how
// content can be reached. A feature that widens access is opt-in, or the
// deploy that introduces it silently changes the security posture.
export async function getPodcastSettings() {
  const raw = (await redis().hgetall(k("settings"))) || {};
  return { enabled: raw.podcastEnabled === true || raw.podcastEnabled === "true" };
}

export async function savePodcastEnabled(enabled) {
  await redis().hset(k("settings"), { podcastEnabled: Boolean(enabled) });
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

// Geo-location whitelist — only the enforcement toggles are admin-editable
// (Settings tab, off by default); the country lists themselves come from the
// GEO_WHITELIST / ADMIN_GEO_WHITELIST env vars (see lib/geo.js) so an admin
// can always fix their own access from Vercel's env var editor without
// needing the app itself to be reachable first.
export async function getGeoSettings() {
  const raw = (await redis().hgetall(k("settings"))) || {};
  return {
    geoEnabled: raw.geoEnabled === true || raw.geoEnabled === "true",
    adminGeoEnabled:
      raw.adminGeoEnabled === true || raw.adminGeoEnabled === "true",
  };
}

export async function saveGeoEnabled(enabled) {
  await redis().hset(k("settings"), { geoEnabled: Boolean(enabled) });
}

export async function saveAdminGeoEnabled(enabled) {
  await redis().hset(k("settings"), { adminGeoEnabled: Boolean(enabled) });
}
