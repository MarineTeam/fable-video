// Role-based access control.
//
// Three roles, each a strict superset of the one below it:
//   viewer  — watch whatever their groups allow (the default; no admin panel)
//   manager — viewer, plus the video library, sharing, and read-only insights
//   admin   — manager, plus people (viewers/roles/groups) and site settings
//
// Roles live in Redis (k("roles")) so an admin can promote or demote someone
// from /admin without a redeploy. ADMIN_EMAILS is NOT replaced by that: it
// stays a bootstrap seed whose members are admins unconditionally and can
// never be demoted through the UI. That asymmetry is deliberate — it is the
// recovery path. If the roles hash is emptied, corrupted, or written badly,
// an ADMIN_EMAILS address can still sign in and repair it; without it, a
// single bad Redis write could permanently lock every admin out of a live
// portal with no way back in short of a redeploy.
//
// Resolution FAILS CLOSED: any error reading Redis yields the least
// privileged answer (viewer, not approved), never an escalation. This
// matches lib/guard.js's existing approval semantics.
import { k, redis } from "./redis";
import { adminEmails, isEnvAdmin, normalizeEmail } from "./auth";
import {
  DEFAULT_ROLE,
  clampRole,
  isStaffRole,
  roleCapabilities,
} from "./capabilities";
import { allowedVideoIds } from "./groups";
import { getViewerMeta } from "./store";

// The pure policy tables live in lib/capabilities.js so client components can
// import capability names without pulling Redis into the browser bundle.
// Re-exported here so server code has one place to import from.
export {
  CAP,
  DEFAULT_ROLE,
  ROLES,
  clampRole,
  hasCapability,
  isRole,
  isStaffRole,
  roleCapabilities,
  roleHasCapability,
  scopeAllows,
} from "./capabilities";

// Raw stored roles, unmerged with ADMIN_EMAILS. Callers that want the
// effective role must use resolveRole/resolveAccess instead.
export async function listStoredRoles() {
  const raw = (await redis().hgetall(k("roles"))) || {};
  const out = {};
  for (const [email, role] of Object.entries(raw)) {
    out[normalizeEmail(email)] = clampRole(role);
  }
  return out;
}

// Merges the stored roles with the ADMIN_EMAILS seed. Env admins always
// appear as admin regardless of what (if anything) the hash says about them.
export async function listRoles() {
  const stored = await listStoredRoles();
  for (const email of adminEmails()) stored[email] = "admin";
  return stored;
}

// Writes an explicit role. Storing the default role removes the field
// instead of writing "viewer" everywhere, so the hash stays small and only
// ever describes deviations from the default.
export async function setRole(email, role) {
  const normalized = normalizeEmail(email);
  const next = clampRole(role);
  if (next === DEFAULT_ROLE) {
    await redis().hdel(k("roles"), normalized);
  } else {
    await redis().hset(k("roles"), { [normalized]: next });
  }
  return next;
}

export async function removeRole(email) {
  await redis().hdel(k("roles"), normalizeEmail(email));
}

// The effective role for one address. Env admins short-circuit before Redis
// is touched at all, exactly as isAdmin() did before roles existed, so an
// ADMIN_EMAILS admin can still sign in during a Redis outage.
export async function resolveRole(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return DEFAULT_ROLE;
  if (isEnvAdmin(normalized)) return "admin";
  const stored = await redis().hget(k("roles"), normalized);
  return clampRole(stored);
}

// One-shot resolution of everything a request needs to know about who is
// asking: their role, whether they may see videos at all, what they may do,
// and which videos their groups scope them to.
//
//   videoScope === null  -> unrestricted (sees the whole library)
//   videoScope           -> array of the only video ids they may see
//
// Every failure path lands on the least privileged result.
export async function resolveAccess(email, { viewerMeta } = {}) {
  const normalized = normalizeEmail(email);
  const denied = {
    email: normalized,
    role: DEFAULT_ROLE,
    approved: false,
    capabilities: [],
    videoScope: [],
  };
  if (!normalized) return denied;

  // ADMIN_EMAILS is resolved without any Redis call so the bootstrap admin
  // is never locked out by an infra failure.
  if (isEnvAdmin(normalized)) {
    return {
      email: normalized,
      role: "admin",
      approved: true,
      capabilities: roleCapabilities("admin"),
      videoScope: null,
    };
  }

  let role = DEFAULT_ROLE;
  let meta = viewerMeta;
  try {
    const [storedRole, resolvedMeta] = await Promise.all([
      redis().hget(k("roles"), normalized),
      meta === undefined ? getViewerMeta(normalized) : Promise.resolve(meta),
    ]);
    role = clampRole(storedRole);
    meta = resolvedMeta;
  } catch (err) {
    // Fail closed — an infra error never grants access or privileges.
    console.error("Could not resolve access:", err);
    return denied;
  }

  // A manager or admin is implicitly approved without being on the viewer
  // list, mirroring how an ADMIN_EMAILS admin always was.
  const staff = isStaffRole(role);
  const approved = staff || Boolean(meta);
  if (!approved) return denied;

  // Staff need the whole library to do their job; group scoping applies to
  // plain viewers only.
  let videoScope = null;
  if (!staff) {
    try {
      videoScope = await allowedVideoIds(meta?.tags || []);
    } catch (err) {
      // Fail closed: if we cannot tell what they are allowed to see, they
      // see nothing rather than everything.
      console.error("Could not resolve group video scope:", err);
      return { ...denied, approved: true, role };
    }
  }

  return {
    email: normalized,
    role,
    approved: true,
    capabilities: roleCapabilities(role),
    videoScope,
  };
}
