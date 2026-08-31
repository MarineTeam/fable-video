// Viewer groups.
//
// A group is the first-class form of the viewer tags that already existed
// (v1.14.0): membership is still "this viewer carries this tag", so every
// tag an admin has already applied keeps working exactly as before and no
// migration is needed. What a group adds is an OPTIONAL per-video allowlist.
//
// Scoping rules, in order:
//   * A tag with no group record is a plain label — it grants and restricts
//     nothing, which is what every existing tag is on the day this ships.
//   * A group record with restricted: false is likewise just a label.
//   * A group record with restricted: true limits its members to the videos
//     on its allowlist.
//
// When a viewer belongs to several groups the RESTRICTED ones win: they see
// the union of those groups' allowlists and nothing else. An unrestricted
// group can never widen a restricted one back to the full library —
// otherwise any stray extra tag would silently defeat the restriction.
import { k, redis } from "./redis";

export const MAX_GROUP_NAME_LENGTH = 30;
export const MAX_VIDEOS_PER_GROUP = 500;

// Groups are keyed by their normalized name so that a viewer's existing
// free-text tag ("Team A") resolves to the group record for it without an
// extra membership index to keep in sync.
export function groupId(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function isValidGroupName(name) {
  const id = groupId(name);
  return Boolean(id) && id.length <= MAX_GROUP_NAME_LENGTH;
}

function normalizeGroup(id, raw) {
  return {
    id,
    name: raw?.name || id,
    restricted: raw?.restricted === true || raw?.restricted === "true",
    videoIds: Array.isArray(raw?.videoIds) ? raw.videoIds.filter(Boolean) : [],
    createdAt: raw?.createdAt || null,
    createdBy: raw?.createdBy || null,
    updatedAt: raw?.updatedAt || null,
  };
}

// Every group record, keyed by group id. One Redis command regardless of how
// many groups exist.
export async function getGroupMap() {
  const raw = (await redis().hgetall(k("groups"))) || {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    out[id] = normalizeGroup(id, value);
  }
  return out;
}

export async function listGroups() {
  const map = await getGroupMap();
  return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getGroup(name) {
  const id = groupId(name);
  if (!id) return null;
  const raw = await redis().hget(k("groups"), id);
  return raw ? normalizeGroup(id, raw) : null;
}

// Creates or updates a group. Only the fields present in `patch` change, so
// renaming the display case of a group never clears its allowlist and
// editing an allowlist never flips the restricted flag.
export async function saveGroup(name, patch, actor) {
  const id = groupId(name);
  if (!id) return null;
  const existing = (await getGroup(id)) || {
    id,
    name: String(name).trim(),
    restricted: false,
    videoIds: [],
    createdAt: new Date().toISOString(),
    createdBy: actor || null,
    updatedAt: null,
  };
  const next = {
    ...existing,
    ...patch,
    id,
    updatedAt: new Date().toISOString(),
  };
  next.videoIds = Array.from(
    new Set(
      (Array.isArray(next.videoIds) ? next.videoIds : [])
        .map((v) => String(v).trim())
        .filter(Boolean)
    )
  ).slice(0, MAX_VIDEOS_PER_GROUP);
  next.restricted = next.restricted === true;
  await redis().hset(k("groups"), { [id]: next });
  return next;
}

export async function deleteGroup(name) {
  const id = groupId(name);
  if (!id) return false;
  const removed = await redis().hdel(k("groups"), id);
  return Boolean(removed);
}

// Drops a deleted video from every group's allowlist so a group can't keep
// pointing at a video that no longer exists (and so a later video id reuse
// can't silently inherit an old grant).
export async function pruneVideoFromGroups(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return 0;
  const map = await getGroupMap();
  const payload = {};
  for (const group of Object.values(map)) {
    if (!group.videoIds.includes(id)) continue;
    payload[group.id] = {
      ...group,
      videoIds: group.videoIds.filter((v) => v !== id),
      updatedAt: new Date().toISOString(),
    };
  }
  const count = Object.keys(payload).length;
  if (count) await redis().hset(k("groups"), payload);
  return count;
}

// The heart of group scoping, kept pure so it can be tested directly.
// Given a viewer's tags and the group records, returns either null
// (unrestricted — the whole library) or the array of video ids they may see.
export function resolveScope(tags, groupMap) {
  const list = Array.isArray(tags) ? tags : [];
  if (!list.length) return null;
  const map = groupMap || {};
  const restricting = list
    .map((tag) => map[groupId(tag)])
    .filter((group) => group && group.restricted);
  if (!restricting.length) return null;
  return Array.from(
    new Set(
      restricting.flatMap((group) =>
        Array.isArray(group.videoIds) ? group.videoIds : []
      )
    )
  );
}

// Redis-backed wrapper around resolveScope.
//
// Callers MUST treat a thrown error as "deny", not "allow": see
// lib/roles.js's resolveAccess, which fails closed around this.
export async function allowedVideoIds(tags) {
  const list = Array.isArray(tags) ? tags : [];
  if (!list.length) return null;
  return resolveScope(list, await getGroupMap());
}
