// Scheduled publish / expiry per video.
//
// A schedule is a window: publishAt (don't show before) and expiresAt (don't
// show after), either or both optional. Absence means "no constraint", so a
// video with no schedule record behaves exactly as every video did before
// this existed — the same backwards-compatibility shape as groups.
//
// Schedules live in one hash (k("schedule")), video id -> { publishAt,
// expiresAt }, so checking the whole library costs one Redis command.
//
// This hides a video from VIEWERS. Staff keep seeing everything, because an
// admin has to be able to find and edit a video that isn't live yet — the
// admin list shows the schedule as a badge instead.
import { k, redis } from "./redis";

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// The most per-group windows one video may carry. Generous for a real
// library; it bounds what one record can grow to.
export const MAX_GROUP_WINDOWS = 20;

// A group id arrives as an object KEY, so the three names that are not plain
// keys on a JS object are refused outright rather than trusted to a
// null-prototype object alone.
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export function isUsableGroupKey(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 60 && !RESERVED_KEYS.has(id);
}

function normalizeWindow(raw) {
  const publishAt = isoOrNull(raw?.publishAt);
  const expiresAt = isoOrNull(raw?.expiresAt);
  if (!publishAt && !expiresAt) return null;
  return { publishAt, expiresAt };
}

// A schedule is the default window, plus optional PER-GROUP windows:
//
//   { publishAt, expiresAt, groups: { "<groupId>": { publishAt, expiresAt } } }
//
// Group windows are ADDITIVE ONLY — "also visible to this group during this
// window" — never a way to hold a video back from a group. See isLiveFor for
// why that is a safety property, not a missing feature.
function normalizeSchedule(raw) {
  const base = normalizeWindow(raw);
  let groups = null;
  if (raw?.groups && typeof raw.groups === "object" && !Array.isArray(raw.groups)) {
    for (const [id, value] of Object.entries(raw.groups).slice(0, MAX_GROUP_WINDOWS)) {
      if (!isUsableGroupKey(id)) continue;
      const window = normalizeWindow(value);
      if (!window) continue;
      groups = groups || Object.create(null);
      groups[id] = window;
    }
  }
  if (!base && !groups) return null;
  const out = { publishAt: base?.publishAt || null, expiresAt: base?.expiresAt || null };
  if (groups) out.groups = { ...groups };
  return out;
}

// Pure window check, kept separate from storage so it is directly testable.
// `now` is injectable for the same reason.
//
// A malformed stored value normalizes to null (no constraint) rather than
// throwing — a bad date must not take a video off the air, and must not
// break the whole library listing either.
export function isLive(schedule, now = Date.now()) {
  if (!schedule) return true;
  const at = typeof now === "number" ? now : new Date(now).getTime();
  const { publishAt, expiresAt } = schedule;
  if (publishAt && at < new Date(publishAt).getTime()) return false;
  if (expiresAt && at >= new Date(expiresAt).getTime()) return false;
  return true;
}

// Whether a video is live for a viewer in `groupIds`: live under the default
// window, OR under the window of any group they belong to.
//
// ADDITIVE ON PURPOSE. Every place that checks a window has to be handed the
// viewer's groups, and one of them will eventually be missed. With additive
// windows, a missed call site only withholds an early preview from a group
// (the default applies) — the safe direction. If a group window could DELAY
// a video, the same slip would show it to that group early, which is a leak.
// Holding a video back from a group is what group restrictions are for.
//
// A record with no default window is live for everyone already, so group
// windows on it change nothing — also additive.
export function isLiveFor(schedule, groupIds, now = Date.now()) {
  if (isLive(schedule, now)) return true;
  const groups = schedule?.groups;
  if (!groups || !Array.isArray(groupIds)) return false;
  return groupIds.some(
    (id) => isUsableGroupKey(id) && Object.prototype.hasOwnProperty.call(groups, id) && isLive(groups[id], now)
  );
}

// Describes a schedule for the admin UI: "Scheduled", "Expired", or "Live".
export function scheduleState(schedule, now = Date.now()) {
  if (!schedule) return "live";
  const at = typeof now === "number" ? now : new Date(now).getTime();
  if (schedule.publishAt && at < new Date(schedule.publishAt).getTime()) {
    return "scheduled";
  }
  if (schedule.expiresAt && at >= new Date(schedule.expiresAt).getTime()) {
    return "expired";
  }
  return "live";
}

export async function getScheduleMap() {
  const raw = (await redis().hgetall(k("schedule"))) || {};
  const out = {};
  for (const [videoId, value] of Object.entries(raw)) {
    const schedule = normalizeSchedule(value);
    if (schedule) out[videoId] = schedule;
  }
  return out;
}

export async function getSchedule(videoId) {
  const raw = await redis().hget(k("schedule"), String(videoId));
  return normalizeSchedule(raw);
}

// Writing an empty window deletes the record — "no schedule" is the absence
// of a row, never a row full of nulls, so the hash only ever describes
// videos that actually have a constraint.
export async function setSchedule(videoId, { publishAt, expiresAt, groups } = {}) {
  const id = String(videoId || "").trim();
  if (!id) return null;
  const schedule = normalizeSchedule({ publishAt, expiresAt, groups });
  if (!schedule) {
    await redis().hdel(k("schedule"), id);
    return null;
  }
  await redis().hset(k("schedule"), { [id]: schedule });
  return schedule;
}

// Called when a group is deleted. Group ids are derived from group NAMES, so a
// later group of the same name would otherwise inherit every early-access
// window the old one had — access nobody granted to the new group.
export async function pruneGroupFromSchedules(groupId) {
  const gid = String(groupId || "");
  if (!isUsableGroupKey(gid)) return 0;
  const map = await getScheduleMap();
  let touched = 0;
  for (const [videoId, schedule] of Object.entries(map)) {
    if (!schedule.groups || !Object.prototype.hasOwnProperty.call(schedule.groups, gid)) continue;
    const groups = { ...schedule.groups };
    delete groups[gid];
    await setSchedule(videoId, { publishAt: schedule.publishAt, expiresAt: schedule.expiresAt, groups });
    touched += 1;
  }
  return touched;
}

export async function clearSchedule(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return;
  await redis().hdel(k("schedule"), id);
}

// Validates incoming per-group windows against the groups that exist. Returns
// an error string, or null. An unknown group is refused rather than stored:
// a window for a group that does not exist yet would silently apply to
// whichever group is later created with that name.
export function validateGroupWindows(groups, knownGroupIds) {
  if (groups === undefined || groups === null) return null;
  if (typeof groups !== "object" || Array.isArray(groups)) return "Group windows must be an object";
  const entries = Object.entries(groups);
  if (entries.length > MAX_GROUP_WINDOWS) return `At most ${MAX_GROUP_WINDOWS} group windows`;
  const known = new Set(knownGroupIds || []);
  for (const [id, window] of entries) {
    if (!isUsableGroupKey(id) || !known.has(id)) return "One of the groups no longer exists — reload and try again";
    const problem = validateWindow(window || {});
    if (problem) return problem;
  }
  return null;
}

// Validates an incoming window before it is stored. Returns an error string,
// or null when the window is usable.
export function validateWindow({ publishAt, expiresAt }) {
  if (publishAt && !isoOrNull(publishAt)) return "Publish date isn't a valid date";
  if (expiresAt && !isoOrNull(expiresAt)) return "Expiry date isn't a valid date";
  const start = isoOrNull(publishAt);
  const end = isoOrNull(expiresAt);
  if (start && end && new Date(end).getTime() <= new Date(start).getTime()) {
    return "Expiry must be after the publish date";
  }
  return null;
}
