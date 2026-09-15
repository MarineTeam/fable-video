// Role administration: create, edit, delete roles, and assign them to people.
//
// Every mutating branch enforces the no-escalation rule from
// lib/capabilities.js: the actor may only create, edit, delete or assign a
// role whose capabilities they already hold themselves. Owners (ADMIN_EMAILS)
// hold the whole catalog, so the rule is invisible to them and a hard ceiling
// for anyone they delegate CAP.ROLES_MANAGE to. Without it, handing someone
// role management would be handing them every capability, one self-assignment
// later — which is exactly why an admin-writable permission store is a bigger
// prize than an env var.
//
// GET also runs the legacy-role migration, best-effort. That is the one place
// it can safely live: it needs CAP.ROLES_MANAGE to reach, it is idempotent,
// and an owner opening the Roles tab is the natural moment to convert. Until
// it runs, lib/roleMigration.js's read-time fallback keeps everyone's old
// permissions working, so nothing depends on it happening promptly.
import { requireCapability } from "../../../lib/guard";
import {
  CAP,
  CAPABILITY_INFO,
  MAX_ROLES,
  deleteRole,
  isValidRoleId,
  loadRoleAssignments,
  loadRoles,
  normalizeCapabilities,
  normalizeRoleName,
  roleIdFromName,
  saveRole,
  setRolesForEmail,
  sortedRoles,
  undelegatableCapabilities,
} from "../../../lib/roles";
import { findLegacyAssignments, migrateLegacyRoles } from "../../../lib/roleMigration";
import { isValidEmail, normalizeEmail } from "../../../lib/auth";
import { oneTrimmed } from "../../../lib/params";
import { allowRequest } from "../../../lib/ratelimit";
import { logAction } from "../../../lib/audit";
import { withMonitorApi } from "../../../lib/monitor";

async function handler(req, res) {
  // Guard first, before the method check — see change-control rule 1.
  const actor = await requireCapability(req, res, CAP.ROLES_MANAGE);
  if (!actor) return;
  const admin = actor.email;

  if (req.method !== "GET" && !(await allowRequest("roles", admin, 20, "1 m"))) {
    return res.status(429).json({ error: "Too many requests — slow down a little" });
  }

  if (req.method === "GET") {
    // Best-effort and idempotent: a migration failure must not stop the tab
    // from loading, because the read-time fallback means nothing is broken
    // while it stays unconverted.
    let migrated = null;
    try {
      const result = await migrateLegacyRoles();
      if (result.migrated) {
        migrated = result;
        await logAction(
          admin,
          "role.migrate",
          `${result.migrated} legacy assignment(s) → ${result.roles.join(", ")}`
        );
      }
    } catch (err) {
      console.error("Could not migrate legacy roles:", err);
    }

    try {
      const [rolesById, assignments, pendingLegacy] = await Promise.all([
        loadRoles(),
        loadRoleAssignments(),
        findLegacyAssignments().catch(() => ({})),
      ]);
      return res.json({
        roles: sortedRoles(rolesById),
        assignments,
        catalog: CAPABILITY_INFO,
        maxRoles: MAX_ROLES,
        // The actor's own set is the ceiling the UI should grey out against,
        // so someone with delegated roles.manage sees why a box is disabled
        // rather than getting a 403 after clicking Save.
        actor: { email: admin, owner: actor.owner, capabilities: actor.capabilities },
        migrated,
        legacyRemaining: Object.keys(pendingLegacy).length,
      });
    } catch (err) {
      console.error("Could not load roles:", err);
      return res.status(502).json({ error: "Could not load roles" });
    }
  }

  if (req.method === "POST") {
    const name = normalizeRoleName(oneTrimmed(req.body?.name));
    if (!name) return res.status(400).json({ error: "Give the role a name" });
    const capabilities = normalizeCapabilities(req.body?.capabilities);
    const refused = undelegatableCapabilities(actor.capabilities, capabilities);
    if (refused.length) {
      return res
        .status(403)
        .json({ error: "You can't grant capabilities you don't hold", refused });
    }
    try {
      const existing = await loadRoles();
      if (Object.keys(existing).length >= MAX_ROLES) {
        return res.status(400).json({ error: `At most ${MAX_ROLES} roles` });
      }
      const result = await saveRole({ id: roleIdFromName(name), name, capabilities });
      if (!result.ok) return res.status(400).json({ error: result.error });
      await logAction(admin, "role.create", `${name} [${capabilities.join(", ")}]`);
      return res.json({ role: result.role });
    } catch (err) {
      console.error("Could not create the role:", err);
      return res.status(502).json({ error: "Could not create the role" });
    }
  }

  if (req.method === "PUT") {
    const id = oneTrimmed(req.body?.id);
    if (!isValidRoleId(id)) return res.status(400).json({ error: "Bad role id" });
    const name = normalizeRoleName(oneTrimmed(req.body?.name));
    if (!name) return res.status(400).json({ error: "Give the role a name" });
    const capabilities = normalizeCapabilities(req.body?.capabilities);
    try {
      const rolesById = await loadRoles();
      const current = rolesById[id];
      if (!current) return res.status(404).json({ error: "No such role" });
      // Both sides are checked: the NEW set so the actor cannot grant upward,
      // and the CURRENT set so they cannot tamper with a role more powerful
      // than themselves at all — editing a role you could not have created is
      // the same escalation by a different door.
      const refused = [
        ...new Set([
          ...undelegatableCapabilities(actor.capabilities, current.capabilities),
          ...undelegatableCapabilities(actor.capabilities, capabilities),
        ]),
      ].sort();
      if (refused.length) {
        return res
          .status(403)
          .json({ error: "That role is outside your own capabilities", refused });
      }
      const result = await saveRole({ ...current, name, capabilities });
      if (!result.ok) return res.status(400).json({ error: result.error });
      await logAction(admin, "role.update", `${name} [${capabilities.join(", ")}]`);
      return res.json({ role: result.role });
    } catch (err) {
      console.error("Could not update the role:", err);
      return res.status(502).json({ error: "Could not update the role" });
    }
  }

  if (req.method === "PATCH") {
    // Assignment: replace one person's whole role list.
    const email = normalizeEmail(oneTrimmed(req.body?.email));
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "That doesn't look like an email address" });
    }
    const requested = Array.isArray(req.body?.roleIds)
      ? req.body.roleIds.filter((id) => typeof id === "string")
      : [];
    try {
      const [rolesById, assignments] = await Promise.all([loadRoles(), loadRoleAssignments()]);
      const capsOf = (ids) =>
        normalizeCapabilities((ids || []).flatMap((rid) => rolesById[rid]?.capabilities || []));
      // The union of what is being added AND what is being taken away: an
      // actor may not strip a role they could not have granted either, or
      // "demote the person above me" becomes the escalation path.
      const touched = normalizeCapabilities([
        ...capsOf(assignments[email] || []),
        ...capsOf(requested),
      ]);
      const refused = undelegatableCapabilities(actor.capabilities, touched);
      if (refused.length) {
        return res
          .status(403)
          .json({ error: "That assignment is outside your own capabilities", refused });
      }
      const result = await setRolesForEmail(email, requested, rolesById);
      if (!result.ok) return res.status(400).json({ error: result.error });
      await logAction(
        admin,
        "role.assign",
        `${email} → ${result.roleIds.length ? result.roleIds.join(", ") : "(none)"}`
      );
      return res.json({ email, roleIds: result.roleIds });
    } catch (err) {
      console.error("Could not update the assignment:", err);
      return res.status(502).json({ error: "Could not update the assignment" });
    }
  }

  if (req.method === "DELETE") {
    const id = oneTrimmed(req.query.id) || oneTrimmed(req.body?.id);
    if (!isValidRoleId(id)) return res.status(400).json({ error: "Bad role id" });
    try {
      const rolesById = await loadRoles();
      const current = rolesById[id];
      if (!current) return res.json({ ok: true });
      const refused = undelegatableCapabilities(actor.capabilities, current.capabilities);
      if (refused.length) {
        return res
          .status(403)
          .json({ error: "That role is outside your own capabilities", refused });
      }
      await deleteRole(id);
      await logAction(admin, "role.delete", current.name);
      return res.json({ ok: true });
    } catch (err) {
      console.error("Could not delete the role:", err);
      return res.status(502).json({ error: "Could not delete the role" });
    }
  }

  res.setHeader("Allow", "GET, POST, PUT, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
