// Redis side of the role system. Two hashes, so both directions are one round
// trip:
//
//   k("roles")       roleId -> { id, name, capabilities[], createdAt, updatedAt }
//   k("user:roles")  email  -> [roleId, ...]
//
// Neither is consulted for owners: ADMIN_EMAILS resolves to the full catalog
// without reading Redis at all, so no stored data — and no Redis outage — can
// demote a bootstrap admin (lib/capabilities.js property 2).
//
// NOTE ON k("roles"): under the previous fixed-role model this same hash held
// email -> "manager" | "admin". Those rows can still be present on a live
// store. They are inert here — parseRole rejects a bare string, and
// isValidRoleId rejects anything containing "@" or "." — so the two shapes
// coexist without corrupting each other. lib/roleMigration.js converts them,
// and resolveCapabilities reads them as a fallback until it has, so nobody is
// locked out in the window between deploy and migration.
import { k, redis } from "./redis";
import { adminEmails, isEnvAdmin, normalizeEmail } from "./auth";
import {
  effectiveCapabilities,
  emailsWithCapability,
  hasAnyCapability,
  isValidRoleId,
  normalizeCapabilities,
  normalizeRoleName,
} from "./capabilities";
import { legacyCapabilitiesFor } from "./roleMigration";
import { allowedVideoIds } from "./groups";
import { getViewerMeta } from "./store";

// The pure policy tables live in lib/capabilities.js so client components can
// import capability names without pulling Redis into the browser bundle.
// Re-exported here so server code has one place to import from.
export {
  ALL_CAPABILITIES,
  CAP,
  assignmentNeedsViewerManage,
  CAPABILITY_INFO,
  MAX_ROLE_NAME_LENGTH,
  canDelegate,
  effectiveCapabilities,
  hasAnyCapability,
  hasCapability,
  isCapability,
  isValidRoleId,
  normalizeCapabilities,
  normalizeRoleName,
  roleIdFromName,
  scopeAllows,
  undelegatableCapabilities,
} from "./capabilities";

export const MAX_ROLES = 50;
export const MAX_ROLES_PER_USER = 10;

const rolesKey = () => k("roles");
const assignmentsKey = () => k("user:roles");

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// The Upstash client parses JSON on read, but a raw string left by another
// tool is handled defensively too.
function parseList(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  if (typeof value === "string") {
    const parsed = safeParse(value);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  }
  return [];
}

// Returns null for anything that is not a usable role record — which is also
// what makes a leftover legacy row (email -> "admin") invisible to loadRoles.
function parseRole(id, value) {
  if (!isValidRoleId(id)) return null;
  const raw = typeof value === "string" ? safeParse(value) : value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const name = normalizeRoleName(raw.name);
  if (!name) return null;
  return {
    id,
    name,
    capabilities: normalizeCapabilities(raw.capabilities),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

// roleId -> role, skipping records that no longer parse into a usable role.
export async function loadRoles() {
  const raw = (await redis().hgetall(rolesKey())) || {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    const role = parseRole(id, value);
    if (role) out[id] = role;
  }
  return out;
}

export function sortedRoles(rolesById) {
  return Object.values(rolesById || {}).sort((a, b) => a.name.localeCompare(b.name));
}

// email -> [roleId, ...], for every user holding at least one role.
export async function loadRoleAssignments() {
  const raw = (await redis().hgetall(assignmentsKey())) || {};
  const out = {};
  for (const [email, value] of Object.entries(raw)) {
    const ids = parseList(value);
    if (ids.length) out[normalizeEmail(email)] = ids;
  }
  return out;
}

export async function rolesForEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  return parseList(await redis().hget(assignmentsKey(), normalized));
}

// The single resolution point used by the guards. Owners short-circuit before
// any Redis call; everyone else fails CLOSED to zero capabilities, because an
// authorization check must never be widened by an infrastructure error.
export async function resolveCapabilities(email, { owner } = {}) {
  const normalized = normalizeEmail(email);
  if (owner ?? isEnvAdmin(normalized)) return effectiveCapabilities({ owner: true });
  if (!normalized) return [];
  try {
    const [roleIds, rolesById] = await Promise.all([rolesForEmail(normalized), loadRoles()]);
    const caps = effectiveCapabilities({ owner: false, roleIds, rolesById });
    if (caps.length) return caps;
    // Nothing under the new model. Before concluding "no capabilities", check
    // for an un-migrated fixed-role row — otherwise the deploy that introduced
    // custom roles would silently demote every Redis-promoted admin until
    // someone ran the migration. Returns [] once the legacy row is gone.
    return await legacyCapabilitiesFor(normalized);
  } catch (err) {
    console.error("Could not resolve capabilities:", err);
    return [];
  }
}

export async function saveRole(role) {
  if (!isValidRoleId(role?.id)) return { ok: false, error: "Bad role id" };
  const name = normalizeRoleName(role.name);
  if (!name) return { ok: false, error: "Bad role name" };
  const record = {
    id: role.id,
    name,
    capabilities: normalizeCapabilities(role.capabilities),
    createdAt: role.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await redis().hset(rolesKey(), { [role.id]: record });
  return { ok: true, role: record };
}

// Deleting a role also strips it from everyone holding it, so a stale id can
// never linger in an assignment list and silently come back to life if a
// future record reuses the id.
export async function deleteRole(id) {
  const r = redis();
  await r.hdel(rolesKey(), id);
  const assignments = await loadRoleAssignments().catch(() => ({}));
  await Promise.all(
    Object.entries(assignments)
      .filter(([, ids]) => ids.includes(id))
      .map(([email, ids]) => {
        const next = ids.filter((rid) => rid !== id);
        return next.length
          ? r.hset(assignmentsKey(), { [email]: next })
          : r.hdel(assignmentsKey(), email);
      })
  );
  return { ok: true };
}

// Replaces a user's whole role list. Ids with no live role record are dropped
// rather than stored, so the hash never accumulates references to nothing.
export async function setRolesForEmail(email, roleIds, rolesById) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, error: "Bad email" };
  const next = [
    ...new Set((Array.isArray(roleIds) ? roleIds : []).filter((id) => (rolesById || {})[id])),
  ]
    .slice(0, MAX_ROLES_PER_USER)
    .sort();
  if (next.length) await redis().hset(assignmentsKey(), { [normalized]: next });
  else await redis().hdel(assignmentsKey(), normalized);
  return { ok: true, roleIds: next };
}

// Called when a viewer is removed outright, so no orphaned assignment
// survives. Also clears any leftover legacy row for that address.
export async function clearRolesForEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  const r = redis();
  await Promise.all([
    r.hdel(assignmentsKey(), normalized).catch(() => {}),
    r.hdel(rolesKey(), normalized).catch(() => {}),
  ]);
}

// Everyone who can action something gated on `cap`, for addressing a
// notification. Degrades to the owner list if the role data cannot be read:
// telling fewer of the right people beats telling nobody, and this is a
// convenience path that must never throw into the action it describes.
export async function emailsHoldingCapability(cap) {
  const owners = adminEmails();
  try {
    const [rolesById, assignments] = await Promise.all([loadRoles(), loadRoleAssignments()]);
    return emailsWithCapability({ owners, assignments, rolesById, cap });
  } catch (err) {
    console.error("Could not resolve capability holders:", err);
    return owners;
  }
}

// One-shot resolution of everything a request needs to know about who is
// asking: whether they may see videos at all, what they may do, and which
// videos their groups scope them to.
//
//   videoScope === null  -> unrestricted (sees the whole library)
//   videoScope           -> array of the only video ids they may see
//
// Every failure path lands on the least privileged result.
export async function resolveAccess(email, { viewerMeta } = {}) {
  const normalized = normalizeEmail(email);
  const denied = {
    email: normalized,
    owner: false,
    staff: false,
    approved: false,
    capabilities: [],
    videoScope: [],
  };
  if (!normalized) return denied;

  // ADMIN_EMAILS is resolved without any Redis call so the bootstrap admin is
  // never locked out by an infra failure.
  if (isEnvAdmin(normalized)) {
    return {
      email: normalized,
      owner: true,
      staff: true,
      approved: true,
      capabilities: effectiveCapabilities({ owner: true }),
      videoScope: null,
    };
  }

  let capabilities = [];
  let meta = viewerMeta;
  try {
    const [caps, resolvedMeta] = await Promise.all([
      resolveCapabilities(normalized, { owner: false }),
      meta === undefined ? getViewerMeta(normalized) : Promise.resolve(meta),
    ]);
    capabilities = caps;
    meta = resolvedMeta;
  } catch (err) {
    // Fail closed — an infra error never grants access or privileges.
    console.error("Could not resolve access:", err);
    return denied;
  }

  // Anyone an owner trusted with an admin capability can watch the library
  // too — strictly less privilege than what they were already granted.
  const staff = hasAnyCapability(capabilities);
  const approved = staff || Boolean(meta);
  if (!approved) return denied;

  // Staff need the whole library to do their job; group scoping applies to
  // people without any admin capability.
  let videoScope = null;
  if (!staff) {
    try {
      videoScope = await allowedVideoIds(meta?.tags || []);
    } catch (err) {
      // Fail closed: if we cannot tell what they are allowed to see, they see
      // nothing rather than everything.
      console.error("Could not resolve group video scope:", err);
      return { ...denied, approved: true };
    }
  }

  return { email: normalized, owner: false, staff, approved: true, capabilities, videoScope };
}
