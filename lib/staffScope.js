// Group-scoped staff: storage, and the video set a scope reaches.
//
//   k("user:scope")  email -> [groupId, ...]   (absent = unscoped)
//
// The rules are pure and live in lib/staffScopeRules.js; resolution is in
// lib/roles.js resolveAccess(). Owners (ADMIN_EMAILS) are never scoped: the
// resolver ignores this hash for them, and /api/admin/roles refuses to write
// one.
//
// An EMPTY list is stored, never deleted, when the last group of a scope goes
// away: absent means "the whole portal", so deleting the row would widen the
// person to everything at the moment their groups disappeared.
import { k, redis } from "./redis";
import { normalizeEmail } from "./auth";
import { getVideo } from "./bunny";
import { allowedVideoIds, getGroupMap } from "./groups";
import { getShares } from "./shares";
import { isScoped, mayDeleteVideo, normalizeScope, videoInScope } from "./staffScopeRules";

const scopeKey = () => k("user:scope");

function parse(value) {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  // Anything present but unreadable is scoped to nothing, not unscoped.
  return normalizeScope(Array.isArray(v) ? v : []);
}

// null (unscoped) or the stored group ids. THROWS on a Redis failure: the
// caller is an access decision and must fail closed itself.
export async function scopeForEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  const value = await redis().hget(scopeKey(), e);
  return value === null || value === undefined ? null : parse(value);
}

export async function loadStaffScopes() {
  const raw = (await redis().hgetall(scopeKey())) || {};
  const out = {};
  for (const [email, value] of Object.entries(raw)) out[normalizeEmail(email)] = parse(value);
  return out;
}

// `scope` null clears it (the whole portal again); an array stores it.
export async function setScopeForEmail(email, scope) {
  const e = normalizeEmail(email);
  if (!e) return null;
  const next = normalizeScope(scope);
  if (next === null) await redis().hdel(scopeKey(), e);
  else await redis().hset(scopeKey(), { [e]: JSON.stringify(next) });
  return next;
}

// A deleted group leaves every scope that named it. Group ids come from
// names, so a later group of the same name would otherwise inherit the
// scope. An emptied scope stays stored as [] (see the header).
export async function pruneGroupFromScopes(id) {
  const scopes = await loadStaffScopes();
  const payload = {};
  for (const [email, scope] of Object.entries(scopes)) {
    if (!scope.includes(id)) continue;
    payload[email] = JSON.stringify(scope.filter((g) => g !== id));
  }
  if (Object.keys(payload).length) await redis().hset(scopeKey(), payload);
  return Object.keys(payload).length;
}

// The videos a scope reaches: whatever its restricted groups grant, with
// collections expanded, exactly as for a viewer in those groups — except that
// "no restricting group" means NOTHING here, never the whole library. Throws
// like allowedVideoIds; the caller fails closed.
export async function staffVideoScope(scope) {
  if (!Array.isArray(scope) || !scope.length) return [];
  const ids = await allowedVideoIds(scope);
  return Array.isArray(ids) ? ids : [];
}

// Why a scoped caller may not delete this video, as { status, error }, or
// null when they may (and always null for an unscoped caller). Reads the
// video's collection and every group, because a group outside the scope can
// hold the video through its collection as well as by id.
export async function scopedDeleteProblem(access, videoId) {
  if (!isScoped(access)) return null;
  if (!videoInScope(access, videoId)) return { status: 404, error: "Video not found" };
  let video;
  let groupMap;
  try {
    [video, groupMap] = await Promise.all([getVideo(videoId), getGroupMap()]);
  } catch (err) {
    console.error("Could not check whether a scoped delete is allowed:", err);
    return { status: 502, error: "Could not check who else can see this video — try again" };
  }
  if (!mayDeleteVideo(access, { videoId, collectionId: video?.collectionId }, groupMap)) {
    return {
      status: 403,
      error: "Another group can also see this video, so only someone without a group limit can delete it",
    };
  }
  return null;
}

// The refusal every portal-wide action gives a scoped caller.
export const SCOPED_REFUSAL = "Your access is limited to certain groups, so you can't do that";

// The share ids a scoped caller may not touch: links to videos outside their
// scope, and ids that name no link. Empty for an unscoped caller. Callers
// refuse the whole request when this is non-empty — the Shares tab only ever
// offers in-scope links, so a mixed list is a crafted one.
export async function shareIdsOutsideScope(access, ids) {
  if (!isScoped(access) || !ids.length) return [];
  const found = await getShares(ids);
  return ids.filter((id) => !found[id] || !videoInScope(access, found[id].videoId));
}
