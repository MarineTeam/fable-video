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

// --- Membership -----------------------------------------------------------
//
// A viewer belongs to a group by carrying its tag, so editing membership is
// editing viewer records. Everything below is PURE: it plans the writes, and
// the route executes them. Planning separately is what makes it possible to
// tell an admin exactly what happened to each address they named, rather than
// reporting "saved" over a list where two of the twelve did nothing.
//
// Tags are free text and group ids are the normalized form, so "Team A" and
// "team a" are the same membership. Adding uses the group's canonical name and
// first strips any case variant, which is why a viewer can never end up
// carrying two tags for one group.

// The most changes one request may make. Large enough for a real bulk paste,
// small enough that the per-viewer writes stay bounded.
export const MAX_MEMBERSHIP_CHANGES = 200;

// The per-viewer tag cap. It lives here rather than in a route because a tag
// IS a group membership, and two routes now enforce it — /api/admin/viewers
// (PATCH, editing one viewer's tags) and /api/admin/groups (PATCH, editing one
// group's members). Two copies of a cap is how they drift apart.
export const MAX_TAGS_PER_VIEWER = 20;

// One viewer's tags with a group added or removed. Other tags are untouched,
// and the result is deduped and sorted exactly like setViewerTags stores it.
export function withGroupMembership(tags, groupName, member) {
  const id = groupId(groupName);
  const list = (Array.isArray(tags) ? tags : []).map((t) => String(t || "").trim()).filter(Boolean);
  if (!id) return Array.from(new Set(list)).sort();
  // Strips every case variant, so adding cannot leave a duplicate behind and
  // removing cannot leave one that still grants the group's scope.
  const kept = list.filter((tag) => groupId(tag) !== id);
  const next = member ? [...kept, String(groupName).trim()] : kept;
  return Array.from(new Set(next)).sort();
}

export function isGroupMember(tags, groupName) {
  const id = groupId(groupName);
  if (!id) return false;
  return (Array.isArray(tags) ? tags : []).some((tag) => groupId(tag) === id);
}

// Everyone carrying this group's tag, by email, sorted.
export function membersOfGroup(viewers, groupName) {
  const id = groupId(groupName);
  if (!id) return [];
  return (Array.isArray(viewers) ? viewers : [])
    .filter((viewer) => isGroupMember(viewer?.tags, id))
    .map((viewer) => String(viewer?.email || "").trim())
    .filter(Boolean)
    .sort();
}

// Plans a bulk membership change. Returns the writes to perform and an
// account of every address that was named:
//
//   writes   [{ email, tags }]  viewers whose tag list actually changes
//   added    emails that gained the group
//   removed  emails that lost it
//   noop     already in (on add) or already out (on remove) — not an error
//   unknown  not an approved viewer, so there is no record to tag
//   overflow emails refused because the viewer is at the tag cap
//
// `remove` is applied after `add`, so naming the same address in both is a
// removal rather than an ambiguous outcome. Nothing here writes; nothing here
// decides who may call it.
export function planMembershipChange(
  viewers,
  groupName,
  { add = [], remove = [], maxTags = MAX_TAGS_PER_VIEWER } = {}
) {
  const id = groupId(groupName);
  const plan = { writes: [], added: [], removed: [], noop: [], unknown: [], overflow: [] };
  if (!id) return plan;

  const byEmail = new Map(
    (Array.isArray(viewers) ? viewers : [])
      .map((viewer) => [String(viewer?.email || "").trim().toLowerCase(), viewer])
      .filter(([email]) => email)
  );

  const normalize = (list) =>
    Array.from(
      new Set(
        (Array.isArray(list) ? list : [])
          .map((email) => String(email || "").trim().toLowerCase())
          .filter(Boolean)
      )
    );

  const removing = new Set(normalize(remove));
  // Remove wins, so an address in both lists has one unambiguous outcome.
  const adding = normalize(add).filter((email) => !removing.has(email));

  const apply = (email, member) => {
    const viewer = byEmail.get(email);
    if (!viewer) {
      plan.unknown.push(email);
      return;
    }
    if (isGroupMember(viewer.tags, id) === member) {
      plan.noop.push(email);
      return;
    }
    const tags = withGroupMembership(viewer.tags, member ? groupName : id, member);
    // Only on the way UP: a removal must never be refused for being over a cap
    // that the removal itself reduces.
    if (member && tags.length > maxTags) {
      plan.overflow.push(email);
      return;
    }
    plan.writes.push({ email, tags });
    (member ? plan.added : plan.removed).push(email);
  };

  for (const email of adding) apply(email, true);
  for (const email of removing) apply(email, false);
  return plan;
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
