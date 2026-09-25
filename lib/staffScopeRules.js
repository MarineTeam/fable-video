// Group-scoped staff: the pure rules.
//
// PURE MODULE — no Redis import, so pages/admin.js may use it. Storage lives
// in lib/staffScope.js; resolution in lib/roles.js resolveAccess().
//
// A person's ROLES decide what they may do. Their SCOPE decides where: a list
// of group ids. No scope (null) is the portal as before. A scope limits every
// capability to those groups, their members, and the videos those groups may
// watch.
//
//   staffScope === null        unscoped — the whole portal
//   staffScope === [ids...]    only these groups
//   staffScope === []          scoped to NOTHING — never read as "unscoped"
//
// That last line is the same null-versus-[] rule videoScope already follows
// (architecture-contract invariant (c)): a scope whose groups have all been
// deleted must shrink to nothing, never widen to everything.
//
// Only RESTRICTED groups count. An unrestricted group is a label whose
// members see the whole library, so it cannot bound anything; a scope naming
// one contributes no videos and no people for it.
//
// The four ways scoping could leak, and the rule here that closes each:
//
//   1. Widening your own scope. A scope IS what its groups may watch, so a
//      scoped person must never edit a group's allowlist (except that their
//      own uploads are granted to their groups). GLOBAL_CAPABILITIES are
//      stripped entirely, and the group record routes refuse scoped callers.
//   2. The no-group hole. A viewer in no restricted group sees the whole
//      library. So a scoped person may only approve someone INTO one of their
//      groups, in one write, and may never remove the last restricted group a
//      viewer is in (leavesUnrestricted).
//   3. People shared with other groups. Removing someone from the portal
//      affects every group they are in, so it needs all of them in scope
//      (mayRemovePerson). The same for deleting a video (mayDeleteVideo).
//   4. Handing out scope. roles.manage is global, so no scoped person can set
//      anyone's scope, their own included.
import { CAP, normalizeCapabilities } from "./capabilities";

// lib/groups.js's groupId, repeated because importing that module would pull
// Redis into the browser bundle. groupScope.test.js pins the two together.
export function groupId(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// Portal-wide by nature: they cannot be limited to some groups, so a scoped
// person simply does not hold them, whatever their roles say.
export const GLOBAL_CAPABILITIES = Object.freeze([
  CAP.SETTINGS_MANAGE,
  CAP.ROLES_MANAGE,
  CAP.AUDIT_READ,
  CAP.BROADCAST_SEND,
]);

export const MAX_SCOPE_GROUPS = 20;

// Group ids, deduped and sorted. Anything that is not a usable id is dropped.
// Returns null for "unscoped" and an array (possibly empty) otherwise, so a
// caller never has to guess which of the two an empty value meant.
export function normalizeScope(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => groupId(v)).filter(Boolean))].sort().slice(0, MAX_SCOPE_GROUPS);
}

export function isScoped(access) {
  return Array.isArray(access?.staffScope);
}

export function capabilitiesUnderScope(capabilities, scope) {
  const caps = normalizeCapabilities(capabilities);
  if (!Array.isArray(scope)) return caps;
  return caps.filter((cap) => !GLOBAL_CAPABILITIES.includes(cap));
}

// The restricted groups of a scope that still exist.
export function effectiveScopeGroups(scope, groupMap) {
  if (!Array.isArray(scope)) return null;
  const map = groupMap || {};
  return scope.filter((id) => map[id]?.restricted);
}

// The restricted groups a set of viewer tags puts someone in.
export function restrictedGroupsOf(tags, groupMap) {
  const map = groupMap || {};
  return [
    ...new Set((Array.isArray(tags) ? tags : []).map((t) => groupId(t)).filter((id) => map[id]?.restricted)),
  ].sort();
}

export function groupInScope(access, id, groupMap) {
  if (!isScoped(access)) return true;
  return effectiveScopeGroups(access.staffScope, groupMap).includes(groupId(id));
}

// Is this person (by their viewer tags) one of the scoped caller's people?
export function personInScope(access, tags, groupMap) {
  if (!isScoped(access)) return true;
  const mine = new Set(effectiveScopeGroups(access.staffScope, groupMap));
  return restrictedGroupsOf(tags, groupMap).some((id) => mine.has(id));
}

export function videoInScope(access, videoId) {
  if (!isScoped(access)) return true;
  return Array.isArray(access.videoScope) && access.videoScope.includes(videoId);
}

// Rule 2: would these tags leave a viewer in no restricted group — and so
// with the whole library?
export function leavesUnrestricted(tags, groupMap) {
  return restrictedGroupsOf(tags, groupMap).length === 0;
}

// A scoped caller may change only the tags that are their own groups, and
// may not leave the viewer with no restricted group. Returns an error string,
// or null when the change is allowed. Unscoped callers are not limited here.
export function tagChangeProblem(access, before, after, groupMap) {
  if (!isScoped(access)) return null;
  const mine = new Set(effectiveScopeGroups(access.staffScope, groupMap));
  const outside = (tags) =>
    (Array.isArray(tags) ? tags : [])
      .map((t) => groupId(t))
      .filter((id) => id && !mine.has(id))
      .sort()
      .join("\n");
  if (outside(before) !== outside(after)) {
    return "You can only add or remove your own groups";
  }
  if (leavesUnrestricted(after, groupMap)) {
    return "That would leave them in no restricted group, which shows them the whole library. Remove them instead";
  }
  return null;
}

// Rule 3, for people: every restricted group they are in must be the
// caller's, and they must be in at least one.
export function mayRemovePerson(access, tags, groupMap) {
  if (!isScoped(access)) return true;
  const mine = new Set(effectiveScopeGroups(access.staffScope, groupMap));
  const theirs = restrictedGroupsOf(tags, groupMap);
  return theirs.length > 0 && theirs.every((id) => mine.has(id));
}

// Rule 3, for videos: in scope, and granted to no restricted group outside
// it — directly or through its collection.
export function mayDeleteVideo(access, { videoId, collectionId }, groupMap) {
  if (!isScoped(access)) return true;
  if (!videoInScope(access, videoId)) return false;
  const mine = new Set(effectiveScopeGroups(access.staffScope, groupMap));
  const coll = String(collectionId || "");
  return !Object.values(groupMap || {}).some(
    (group) =>
      group.restricted &&
      !mine.has(group.id) &&
      (group.videoIds.includes(videoId) || (coll && group.collectionIds.includes(coll)))
  );
}

// A scoped caller may set per-group publish windows only for their own
// groups; every other group's window must come back exactly as stored.
export function scheduleGroupsProblem(access, storedGroups, nextGroups, groupMap) {
  if (!isScoped(access)) return null;
  const mine = new Set(effectiveScopeGroups(access.staffScope, groupMap));
  const others = (groups) =>
    JSON.stringify(
      Object.entries(groups && typeof groups === "object" ? groups : {})
        .filter(([id]) => !mine.has(groupId(id)))
        .sort(([a], [b]) => a.localeCompare(b))
    );
  if (others(storedGroups) !== others(nextGroups)) {
    return "You can only set publish windows for your own groups";
  }
  return null;
}

// The group a scoped caller's new viewer goes into: the one they named, if
// it is theirs, else their only group. null when that cannot be decided — the
// caller must then choose, and nothing is written.
export function placementGroup(access, requested, groupMap) {
  if (!isScoped(access)) return undefined;
  const mine = effectiveScopeGroups(access.staffScope, groupMap);
  if (requested) {
    const id = groupId(requested);
    return mine.includes(id) ? id : null;
  }
  return mine.length === 1 ? mine[0] : null;
}
