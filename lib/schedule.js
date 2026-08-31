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

function normalizeSchedule(raw) {
  const publishAt = isoOrNull(raw?.publishAt);
  const expiresAt = isoOrNull(raw?.expiresAt);
  if (!publishAt && !expiresAt) return null;
  return { publishAt, expiresAt };
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
export async function setSchedule(videoId, { publishAt, expiresAt } = {}) {
  const id = String(videoId || "").trim();
  if (!id) return null;
  const schedule = normalizeSchedule({ publishAt, expiresAt });
  if (!schedule) {
    await redis().hdel(k("schedule"), id);
    return null;
  }
  await redis().hset(k("schedule"), { [id]: schedule });
  return schedule;
}

export async function clearSchedule(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return;
  await redis().hdel(k("schedule"), id);
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
