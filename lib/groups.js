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
import { listAllVideos } from "./bunny";

export const MAX_GROUP_NAME_LENGTH = 30;
export const MAX_VIDEOS_PER_GROUP = 500;
// Collections are far coarser than videos — a handful covers a whole library —
// so the cap is small on purpose. It is a guard against a malformed write, not
// a limit anyone should meet.
export const MAX_COLLECTIONS_PER_GROUP = 50;

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
    // Absent on every group written before collection grants existed, which
    // reads as [] — an old group keeps granting exactly the videos it granted.
    collectionIds: Array.isArray(raw?.collectionIds) ? raw.collectionIds.filter(Boolean) : [],
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
    collectionIds: [],
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
  next.collectionIds = Array.from(
    new Set(
      (Array.isArray(next.collectionIds) ? next.collectionIds : [])
        .map((c) => String(c).trim())
        .filter(Boolean)
    )
  ).slice(0, MAX_COLLECTIONS_PER_GROUP);
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

// Adds one video to several groups' allowlists — the upload card's "visible
// to" choice. Each group is written on its own, so one failing costs only
// that group, and the caller is told exactly which did not take: the video
// exists by the time this runs, and the admin must see which groups still
// need it by hand. A group that vanished, or filled up, since the route
// checked is reported as failed rather than recreated or silently truncated
// (saveGroup would do the first for a missing id and the second for a full
// one).
export async function grantVideoToGroups(videoId, groupIds) {
  const id = String(videoId || "").trim();
  const granted = [];
  const failed = [];
  if (!id) return { granted, failed: [...(groupIds || [])] };
  for (const gid of groupIds || []) {
    try {
      const group = await getGroup(gid);
      if (!group) throw new Error("Unknown group");
      if (!group.videoIds.includes(id)) {
        if (group.videoIds.length >= MAX_VIDEOS_PER_GROUP) throw new Error("Group is full");
        await saveGroup(group.id, { videoIds: [...group.videoIds, id] });
      }
      granted.push(group.id);
    } catch (err) {
      console.error("Could not grant an uploaded video to a group:", err);
      failed.push(gid);
    }
  }
  return { granted, failed };
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
//
// Returns null (unrestricted — the whole library) or the GRANTS a viewer's
// restricting groups add up to: an explicit list of videos, and a list of
// collections whose contents are granted wholesale.
//
// It returns grants rather than a finished list of video ids because a
// collection grant cannot be resolved without knowing what is in the library,
// and this module stays pure. allowedVideoIds() does that expansion.
//
// THE SHAPE CHANGED when collection grants were added. It used to return the
// video-id array directly, and keeping that would have meant a caller could
// take the scope and silently miss every collection grant in it — in access
// control, the wrong kind of convenient.
export function resolveScope(tags, groupMap) {
  const list = Array.isArray(tags) ? tags : [];
  if (!list.length) return null;
  const map = groupMap || {};
  const restricting = list
    .map((tag) => map[groupId(tag)])
    .filter((group) => group && group.restricted);
  if (!restricting.length) return null;
  const collect = (key) =>
    Array.from(
      new Set(restricting.flatMap((group) => (Array.isArray(group[key]) ? group[key] : [])))
    );
  return { videoIds: collect("videoIds"), collectionIds: collect("collectionIds") };
}

// Redis-backed wrapper around resolveScope, returning the flat list of video
// ids a viewer may see — the shape scopeAllows() and every call site expect,
// which is why collection grants are expanded HERE rather than changing what
// a scope looks like everywhere.
//
// Expanding per request is what makes a collection grant AUTO-FOLLOW: a video
// uploaded into a granted collection is visible on the next request with no
// admin action, which is the whole reason to grant by collection rather than
// ticking videos one at a time.
//
// The library is read ONLY when some group actually grants a collection. A
// deployment that never uses them pays nothing, and the read that could fail
// is not on a path that did not already need it.
//
// Callers MUST treat a thrown error as "deny", not "allow": see
// lib/roles.js's resolveAccess, which fails closed around this. That now
// includes a bunny.net outage for viewers whose access depends on a
// collection grant — restricted viewers see nothing rather than everything,
// which is the direction this repo fails in by design.
export async function allowedVideoIds(tags) {
  const list = Array.isArray(tags) ? tags : [];
  if (!list.length) return null;
  const grants = resolveScope(list, await getGroupMap());
  if (!grants) return null;
  if (!grants.collectionIds.length) return grants.videoIds;

  const granted = new Set(grants.collectionIds);
  const all = await listAllVideos();
  const fromCollections = all
    .filter((video) => granted.has(String(video?.collectionId || "")))
    .map((video) => video.guid);
  return Array.from(new Set([...grants.videoIds, ...fromCollections]));
}

// Called when a collection is deleted, for the same reason
// pruneVideoFromGroups exists: a grant naming something that no longer exists
// is at best clutter an admin has to reason around, and at worst a grant that
// a recycled id would inherit.
export async function pruneCollectionFromGroups(collectionId) {
  const id = String(collectionId || "").trim();
  if (!id) return 0;
  const map = await getGroupMap();
  const payload = {};
  for (const group of Object.values(map)) {
    if (!group.collectionIds.includes(id)) continue;
    payload[group.id] = {
      ...group,
      collectionIds: group.collectionIds.filter((c) => c !== id),
      updatedAt: new Date().toISOString(),
    };
  }
  const count = Object.keys(payload).length;
  if (count) await redis().hset(k("groups"), payload);
  return count;
}
