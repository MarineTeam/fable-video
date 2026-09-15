// Carries the previous fixed-role model forward onto the custom-role one.
//
// THE HAZARD THIS EXISTS FOR. Both models use k("roles"), with incompatible
// contents:
//
//   before   email  -> "manager" | "admin"      (a bare string)
//   after    roleId -> { id, name, capabilities[] }
//
// The two coexist safely — loadRoles() rejects a bare string, and
// isValidRoleId rejects any field containing "@" or "." — but "safely" here
// means "does not corrupt", not "keeps working". Without this file, the deploy
// that introduced custom roles would read a live store, find no new-model
// assignment for a Redis-promoted admin, and resolve them to zero
// capabilities: silently demoted, mid-flight, with no error anywhere. Only
// ADMIN_EMAILS owners would survive, because they never read Redis at all.
//
// So there are two halves, and both are needed:
//
//   1. `legacyCapabilitiesFor` — a READ-TIME fallback consulted by
//      resolveCapabilities when someone has no new-model roles. Nobody is
//      locked out in the window between deploying and migrating, however long
//      that window is.
//   2. `migrateLegacyRoles` — an IDEMPOTENT conversion that materializes the
//      two old roles as real, editable role records, assigns them to the
//      people who held them, and deletes the legacy rows. Once it has run,
//      half 1 returns [] for everyone and can eventually be deleted.
//
// The mapping below is the old role -> capability table, translated into the
// new catalog. It is deliberately generous rather than minimal: someone who
// could do a thing yesterday must still be able to do it today, or the
// migration is a silent permission cut by another name.
import { k, redis } from "./redis";
import { normalizeEmail } from "./auth";
import { CAP, normalizeCapabilities } from "./capabilities";

// The old model's three roles. "viewer" was the default and granted nothing
// beyond watching, so it has no entry — a viewer row converts to no role at
// all, which is what it already meant.
export const LEGACY_ROLE_NAMES = Object.freeze(["manager", "admin"]);

// manager: the video library, sharing, and read-only insight.
const LEGACY_MANAGER_CAPS = Object.freeze(
  normalizeCapabilities([
    CAP.VIDEOS_READ,
    CAP.VIDEOS_MANAGE,
    CAP.VIDEOS_UPLOAD,
    CAP.SHARES_READ,
    CAP.SHARES_MANAGE,
    CAP.ANALYTICS_READ,
    CAP.AUDIT_READ,
  ])
);

// admin: everything a manager had, plus people and settings. Under the old
// model an admin could reach /api/admin/roles (CAP.PEOPLE) and the push
// broadcast (CAP.SETTINGS), so both carry over.
const LEGACY_ADMIN_CAPS = Object.freeze(
  normalizeCapabilities([
    ...LEGACY_MANAGER_CAPS,
    CAP.VIEWERS_READ,
    CAP.VIEWERS_MANAGE,
    CAP.GROUPS_MANAGE,
    CAP.ROLES_MANAGE,
    CAP.SETTINGS_MANAGE,
    CAP.BROADCAST_SEND,
  ])
);

export const LEGACY_CAPABILITIES = Object.freeze({
  manager: LEGACY_MANAGER_CAPS,
  admin: LEGACY_ADMIN_CAPS,
});

// Fixed ids, so running the migration twice reuses the same records rather
// than creating a second "Admin" every time. They are valid role ids, so the
// Roles tab can rename, re-scope or delete them like any other.
export const LEGACY_ROLE_IDS = Object.freeze({
  manager: "manager-legacy",
  admin: "admin-legacy",
});

// A legacy field is an EMAIL key whose value is one of the old role names.
// Both halves matter: a new-model role id can never contain "@", and a new
// role record is an object rather than a string, so this cannot mistake one
// for the other in either direction.
export function isLegacyRoleEntry(field, value) {
  return (
    typeof field === "string" &&
    field.includes("@") &&
    typeof value === "string" &&
    LEGACY_ROLE_NAMES.includes(value.trim().toLowerCase())
  );
}

// Pure: the capability set a legacy role name maps to.
export function capabilitiesForLegacyRole(roleName) {
  const name = String(roleName || "").trim().toLowerCase();
  return LEGACY_CAPABILITIES[name] ? [...LEGACY_CAPABILITIES[name]] : [];
}

// Read-time fallback (half 1). Returns the capabilities of an un-migrated
// fixed-role row for this address, or [] when there is none — including on any
// Redis failure, because this sits on an authorization path and must fail
// closed like everything else there.
export async function legacyCapabilitiesFor(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  try {
    const value = await redis().hget(k("roles"), normalized);
    if (!isLegacyRoleEntry(normalized, value)) return [];
    return capabilitiesForLegacyRole(value);
  } catch (err) {
    console.error("Could not read a legacy role row:", err);
    return [];
  }
}

// Scans the roles hash for legacy rows without writing anything. Used by the
// Roles tab to say how many are outstanding, and by the migration itself.
export async function findLegacyAssignments() {
  const raw = (await redis().hgetall(k("roles"))) || {};
  const out = {};
  for (const [field, value] of Object.entries(raw)) {
    if (isLegacyRoleEntry(field, value)) {
      out[normalizeEmail(field)] = String(value).trim().toLowerCase();
    }
  }
  return out;
}

// The conversion (half 2). Idempotent: a second run finds no legacy rows and
// changes nothing. Returns a summary so the caller can report what happened
// rather than claiming success blindly.
//
// Order matters and is the fail-safe one: create the role records, then write
// the assignments, and only then delete the legacy rows. A crash at any point
// leaves someone holding BOTH the legacy row and the new assignment — which
// resolves to the same capabilities either way — rather than neither.
export async function migrateLegacyRoles() {
  const summary = { migrated: 0, roles: [], emails: [] };
  const legacy = await findLegacyAssignments();
  const emails = Object.keys(legacy);
  if (!emails.length) return summary;

  const r = redis();
  const needed = [...new Set(Object.values(legacy))];

  // 1. The role records, one per legacy role name actually in use.
  const now = new Date().toISOString();
  const records = {};
  for (const name of needed) {
    const id = LEGACY_ROLE_IDS[name];
    if (!id) continue;
    records[id] = {
      id,
      name: name === "admin" ? "Admin" : "Manager",
      capabilities: capabilitiesForLegacyRole(name),
      createdAt: now,
      updatedAt: now,
    };
  }
  if (Object.keys(records).length) await r.hset(k("roles"), records);
  summary.roles = Object.values(records).map((role) => role.name).sort();

  // 2. The assignments. Merged with anything already there rather than
  // replacing it, so a person who was given a new-model role before the
  // migration ran does not lose it.
  const existing = (await r.hgetall(k("user:roles"))) || {};
  const assignments = {};
  for (const [email, name] of Object.entries(legacy)) {
    const id = LEGACY_ROLE_IDS[name];
    if (!id) continue;
    const prior = Array.isArray(existing[email]) ? existing[email] : [];
    assignments[email] = [...new Set([...prior.filter((v) => typeof v === "string"), id])].sort();
  }
  if (Object.keys(assignments).length) await r.hset(k("user:roles"), assignments);

  // 3. Only now remove the legacy rows.
  await r.hdel(k("roles"), ...emails);

  summary.migrated = emails.length;
  summary.emails = emails.sort();
  return summary;
}
