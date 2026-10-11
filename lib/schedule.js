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

// --- Repeating windows --------------------------------------------------
//
// A weekly slot on the DEFAULT window: { days: [0-6, Sunday = 0], start:
// "HH:MM", end: "HH:MM", timeZone: IANA name }. When present, the video is
// visible only inside a slot (as well as inside publishAt/expiresAt). A slot
// whose end is not after its start runs past midnight into the next day —
// "Saturday 22:00–02:00". It narrows the DEFAULT window only; per-group
// windows are separate grants and are not bound by it.
//
// Narrowing is safe here in a way a delaying GROUP window is not: it lives
// inside isLive(), which every enforcement point (and the public page)
// already calls, so there is no new call site to forget.

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimeZone(zone) {
  if (typeof zone !== "string" || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function minutesOf(time) {
  const m = TIME.exec(String(time || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// A stored repeat rule, cleaned, or null. A malformed one reads as NO rule —
// the same rule as a bad date elsewhere in this file: a typo must not take a
// video off the air. validateRepeat() refuses it on the way in.
function normalizeRepeat(raw) {
  if (!raw || typeof raw !== "object") return null;
  const days = [...new Set((Array.isArray(raw.days) ? raw.days : []).map(Number))]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort();
  const start = minutesOf(raw.start);
  const end = minutesOf(raw.end);
  if (!days.length || start === null || end === null || start === end) return null;
  if (!isValidTimeZone(raw.timeZone)) return null;
  return { days, start: raw.start, end: raw.end, timeZone: raw.timeZone };
}

// The weekday (0-6) and minute of the day at `now`, in `timeZone`.
function localClock(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { day: WEEKDAYS[get("weekday")], minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

// Whether `now` falls inside one of the rule's weekly slots.
export function inRepeatSlot(repeat, now = Date.now()) {
  const rule = normalizeRepeat(repeat);
  if (!rule) return true;
  const { day, minute } = localClock(typeof now === "number" ? now : new Date(now).getTime(), rule.timeZone);
  const start = minutesOf(rule.start);
  const end = minutesOf(rule.end);
  return rule.days.some((d) => {
    if (start < end) return day === d && minute >= start && minute < end;
    // Past midnight: the evening of day d, and the early hours of the next.
    return (day === d && minute >= start) || (day === (d + 1) % 7 && minute < end);
  });
}

// Refuses a rule that would not do what the admin meant. Returns an error
// string or null.
export function validateRepeat(repeat) {
  if (repeat === undefined || repeat === null) return null;
  if (typeof repeat !== "object" || Array.isArray(repeat)) return "The repeat rule is not valid";
  const days = Array.isArray(repeat.days) ? repeat.days : [];
  if (!days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return "Choose at least one day for the repeat";
  }
  const start = minutesOf(repeat.start);
  const end = minutesOf(repeat.end);
  if (start === null || end === null) return "Repeat times must be HH:MM";
  if (start === end) return "A repeat slot must not start and end at the same time";
  if (!isValidTimeZone(repeat.timeZone)) return "The repeat time zone is not recognised";
  return null;
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
  const repeat = normalizeRepeat(raw?.repeat);
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
  if (!base && !groups && !repeat) return null;
  const out = { publishAt: base?.publishAt || null, expiresAt: base?.expiresAt || null };
  if (repeat) out.repeat = repeat;
  if (groups) out.groups = { ...groups };
  return out;
}

// Just the per-group windows, in the form they are stored — so a request's
// windows can be compared with the stored ones without formatting (an ISO
// string's precision, a dropped empty window) reading as a change.
export function normalizeGroupWindows(groups) {
  return normalizeSchedule({ groups })?.groups || {};
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
  // A weekly repeat narrows the window further (see "Repeating windows").
  if (schedule.repeat && !inRepeatSlot(schedule.repeat, at)) return false;
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

// Whether this viewer may act on a video right now as far as its publish
// window goes — the watch page's rule, for the routes that WRITE something
// about a video (a rating, a saved-list entry). Staff are exempt, as on the
// watch page; an unreadable schedule is no constraint, as on the watch page.
// A write must not be possible on a video the viewer cannot yet (or can no
// longer) watch: a vote on an unpublished talk shows up in the staff totals,
// and a saved entry would sit in the list for something that is not there.
export async function viewerMayActOn(access, videoId) {
  if (access?.staff) return true;
  let schedule = null;
  try {
    schedule = await getSchedule(videoId);
  } catch (err) {
    console.error("Could not read the video schedule:", err);
  }
  return isLiveFor(schedule, access?.groupIds);
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
  // Inside its dates but on a weekly rule: "live now" or "between slots".
  if (schedule.repeat) return inRepeatSlot(schedule.repeat, at) ? "live" : "off-slot";
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
export async function setSchedule(videoId, { publishAt, expiresAt, groups, repeat } = {}) {
  const id = String(videoId || "").trim();
  if (!id) return null;
  const schedule = normalizeSchedule({ publishAt, expiresAt, groups, repeat });
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
    await setSchedule(videoId, {
      publishAt: schedule.publishAt,
      expiresAt: schedule.expiresAt,
      repeat: schedule.repeat,
      groups,
    });
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
