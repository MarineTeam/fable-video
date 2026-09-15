// The capability catalog and the pure decision logic of the role system.
//
// PURE MODULE — no Redis import. pages/admin.js renders the Roles tab from
// this catalog, so anything imported here reaches the browser bundle; pulling
// lib/redis.js in would drag Node built-ins (async_hooks, via lib/monitor.js)
// into that bundle and fail the build. Storage lives in lib/roles.js. Same
// split as lib/chapters.js vs lib/videoMeta.js.
//
// Roles are ADMIN-DEFINED, not fixed. There is no viewer/manager/admin
// vocabulary here any more — an owner builds roles out of the catalog below
// and assigns any number of them to a person, whose effective permission is
// the union. Four properties are load-bearing, each with a test in
// lib/__tests__/capabilities.test.js:
//
//   1. Capabilities are defined HERE, in code — never in Redis. Every string
//      below names an enforcement point that actually exists in a route. An
//      admin-invented capability would grant nothing while reading as though
//      it did, so unknown strings are dropped on write and ignored on read.
//   2. ADMIN_EMAILS holds every capability, always, resolved without touching
//      Redis (see lib/roles.js). Owners are the non-removable bootstrap set:
//      Redis can only ADD privilege to other people, never subtract from an
//      owner. Changing that set still needs an env edit and a redeploy. This
//      is the same recovery path the fixed-role model had, unchanged.
//   3. No self-escalation: an actor may only create, edit, delete or assign a
//      role whose capabilities are a SUBSET of their own effective set
//      (`canDelegate`). Someone holding roles.manage can hand out what they
//      already hold and nothing more. Owners hold everything, so the rule is
//      invisible to them and a hard ceiling for everyone else. This property
//      did not exist under fixed roles and does not need to — it is what makes
//      delegating role management safe at all.
//   4. Resolution fails CLOSED — a non-owner whose capabilities cannot be read
//      resolves to zero capabilities (lib/roles.js), matching the approval
//      asymmetry in architecture-contract invariant (c).

export const CAP = Object.freeze({
  VIDEOS_READ: "videos.read",
  VIDEOS_MANAGE: "videos.manage",
  VIDEOS_UPLOAD: "videos.upload",
  VIEWERS_READ: "viewers.read",
  VIEWERS_MANAGE: "viewers.manage",
  SHARES_READ: "shares.read",
  SHARES_MANAGE: "shares.manage",
  ANALYTICS_READ: "analytics.read",
  AUDIT_READ: "audit.read",
  BROADCAST_SEND: "broadcast.send",
  SETTINGS_MANAGE: "settings.manage",
  GROUPS_MANAGE: "groups.manage",
  ROLES_MANAGE: "roles.manage",
});

export const ALL_CAPABILITIES = Object.freeze(Object.values(CAP));

// Shown in the Roles tab. Kept beside the catalog so a new capability cannot
// reach the UI unlabelled.
export const CAPABILITY_INFO = Object.freeze([
  { cap: CAP.VIDEOS_READ, group: "Videos", label: "View the video list" },
  { cap: CAP.VIDEOS_MANAGE, group: "Videos", label: "Rename, delete, reorder, schedule, chapters and notes" },
  { cap: CAP.VIDEOS_UPLOAD, group: "Videos", label: "Upload new videos" },
  { cap: CAP.VIEWERS_READ, group: "Viewers", label: "View the approved viewer list and access requests" },
  { cap: CAP.VIEWERS_MANAGE, group: "Viewers", label: "Add, remove and tag viewers; approve access requests" },
  { cap: CAP.SHARES_READ, group: "Shares", label: "View share links" },
  { cap: CAP.SHARES_MANAGE, group: "Shares", label: "Create, resend, extend and revoke shares" },
  { cap: CAP.ANALYTICS_READ, group: "Insight", label: "View analytics and viewer activity" },
  { cap: CAP.AUDIT_READ, group: "Insight", label: "Read the activity log" },
  { cap: CAP.BROADCAST_SEND, group: "Insight", label: "Send push broadcasts" },
  { cap: CAP.SETTINGS_MANAGE, group: "Admin", label: "Change settings and palette, and publish public links" },
  { cap: CAP.GROUPS_MANAGE, group: "Admin", label: "Manage groups and their membership" },
  { cap: CAP.ROLES_MANAGE, group: "Admin", label: "Manage roles and who holds them" },
]);

export function isCapability(cap) {
  return ALL_CAPABILITIES.includes(cap);
}

// Drop unknowns, dedupe, sort — applied to everything written to or read from
// Redis, so a hand-edited record can never widen the catalog (property 1).
export function normalizeCapabilities(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(isCapability))].sort();
}

export function hasCapability(access, capability) {
  // Accepts either a raw capability array or a resolved access object, because
  // call sites have one or the other and a second helper would be a foot-gun.
  const caps = Array.isArray(access) ? access : access?.capabilities;
  return Array.isArray(caps) && caps.includes(capability);
}

// "Holds the admin area at all." Replaces the old isStaffRole(role): staff is
// now anyone with at least one capability, rather than a role name.
export function hasAnyCapability(access) {
  const caps = Array.isArray(access) ? access : access?.capabilities;
  return Array.isArray(caps) && caps.length > 0;
}

// An owner's set is the whole catalog and never depends on stored data
// (property 2). For everyone else it is the union of their roles'
// capabilities; a role id with no surviving record contributes nothing.
export function effectiveCapabilities({ owner, roleIds, rolesById } = {}) {
  // Sorted in BOTH branches. The union below is sorted anyway, and a function
  // that returns differently-ordered results depending on a flag invites a
  // comparison that passes for one kind of caller and fails for the other.
  if (owner) return [...ALL_CAPABILITIES].sort();
  const out = new Set();
  for (const id of Array.isArray(roleIds) ? roleIds : []) {
    const role = (rolesById || {})[id];
    for (const cap of normalizeCapabilities(role?.capabilities)) out.add(cap);
  }
  return [...out].sort();
}

// Property 3, the whole no-escalation rule in one line: you may only hand out
// what you hold. Called on every role create, edit, delete and assignment.
export function canDelegate(actorCaps, requestedCaps) {
  const held = new Set(Array.isArray(actorCaps) ? actorCaps : []);
  return normalizeCapabilities(requestedCaps).every((cap) => held.has(cap));
}

// The capabilities in `requestedCaps` the actor cannot hand out — so a 403 can
// name them rather than being a bare refusal.
export function undelegatableCapabilities(actorCaps, requestedCaps) {
  const held = new Set(Array.isArray(actorCaps) ? actorCaps : []);
  return normalizeCapabilities(requestedCaps).filter((cap) => !held.has(cap));
}

// Everyone who holds `cap`: the owners (who hold the whole catalog by
// definition) plus every assignee whose roles union to include it. Pure, so
// the caller supplies already-normalized owner addresses and the two stored
// maps. Used to address a notification at the people who can act on it rather
// than at a hardcoded list.
export function emailsWithCapability({ owners = [], assignments = {}, rolesById = {}, cap } = {}) {
  const out = new Set(owners.filter(Boolean));
  for (const [email, roleIds] of Object.entries(assignments)) {
    if (effectiveCapabilities({ owner: false, roleIds, rolesById }).includes(cap)) {
      out.add(email);
    }
  }
  return [...out].sort();
}

export const MAX_ROLE_NAME_LENGTH = 60;

export function normalizeRoleName(raw) {
  const name = String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_ROLE_NAME_LENGTH);
  return name || null;
}

// Ids are derived from the name but stable once created, so renaming a role
// never changes its id and assignments survive a rename. The random suffix
// keeps two roles named alike from collapsing into one record.
export function roleIdFromName(name, rand = () => Math.random().toString(36).slice(2, 8)) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `${slug || "role"}-${rand()}`;
}

// No "@" or "." is accepted, which is what keeps a role id from ever colliding
// with a legacy email-keyed field in the same hash — see lib/roleMigration.js.
export function isValidRoleId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(id);
}

// Group video scoping, unchanged from the fixed-role model and deliberately
// kept: it answers a different question from capabilities (WHICH videos, not
// WHAT actions). null/undefined means unrestricted; an array means those ids
// and no others. Never normalize an empty array to null — architecture-contract
// invariant (c) turns on the distinction.
export function scopeAllows(videoScope, videoId) {
  if (videoScope === null || videoScope === undefined) return true;
  return videoScope.includes(videoId);
}
