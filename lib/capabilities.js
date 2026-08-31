// Role and capability POLICY — pure, storage-free, and safe to import from
// client components.
//
// This is deliberately separate from lib/roles.js: that module reaches into
// Redis (and therefore into lib/monitor.js's async_hooks), so importing it
// from a component would drag server-only code into the browser bundle.
// The admin panel needs the capability names to decide which tabs to render,
// and nothing more, so the names live here.
//
// Deciding what someone may do from these tables is the SERVER's job — the
// admin panel uses them only to avoid showing doors that won't open.

export const ROLES = ["viewer", "manager", "admin"];

export const DEFAULT_ROLE = "viewer";

// Routes declare the capability they need, never a role name, so re-shaping
// a role never means hunting down scattered `role === "admin"` comparisons.
export const CAP = {
  VIDEOS: "videos.manage",
  SHARES: "shares.manage",
  PEOPLE: "people.manage",
  SETTINGS: "settings.manage",
  INSIGHTS: "insights.view",
};

// Each role is a strict superset of the one below it.
const ROLE_CAPABILITIES = {
  viewer: [],
  manager: [CAP.VIDEOS, CAP.SHARES, CAP.INSIGHTS],
  admin: [CAP.VIDEOS, CAP.SHARES, CAP.INSIGHTS, CAP.PEOPLE, CAP.SETTINGS],
};

export function isRole(value) {
  return ROLES.includes(value);
}

// Anything unrecognized degrades to the least privileged role rather than
// throwing — a hand-edited or half-written Redis value must not grant more
// than it should, and must not break the request either.
export function clampRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return isRole(role) ? role : DEFAULT_ROLE;
}

export function roleCapabilities(role) {
  return ROLE_CAPABILITIES[clampRole(role)] || [];
}

export function roleHasCapability(role, capability) {
  return roleCapabilities(role).includes(capability);
}

// True for any role that gets into /admin at all. Used to decide whether to
// render the panel and the "Admin" nav link, never to authorize an action —
// individual routes check their own specific capability.
export function isStaffRole(role) {
  return roleCapabilities(role).length > 0;
}

export function hasCapability(access, capability) {
  return Boolean(access?.capabilities?.includes(capability));
}

// Whether a resolved access record's video scope permits one video id.
//   null / undefined -> unrestricted
//   []               -> the fail-closed result: nothing is permitted
export function scopeAllows(videoScope, videoId) {
  if (videoScope === null || videoScope === undefined) return true;
  return videoScope.includes(videoId);
}
