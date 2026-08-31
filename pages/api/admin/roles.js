// Role assignment. Full admins only (CAP.PEOPLE) — a manager can run the
// library and share it, but may never change who holds which role.
//
// Two rules here exist to keep a live portal recoverable, not to be tidy:
//
//   * You cannot change your own role. Demoting yourself is the easiest way
//     to lock the last admin out of the panel entirely, and self-promotion
//     would make the whole check circular.
//   * You cannot change an ADMIN_EMAILS address's role. Their admin status
//     comes from the environment, not Redis, so a stored role for them would
//     be silently ignored by resolveRole anyway — better to say so than to
//     accept a write that does nothing.
import { requireCapability } from "../../../lib/guard";
import { isValidEmail, isEnvAdmin, normalizeEmail } from "../../../lib/auth";
import { CAP, ROLES, clampRole, isRole, listRoles, setRole } from "../../../lib/roles";
import { logAction } from "../../../lib/audit";
import { withMonitorApi } from "../../../lib/monitor";

async function handler(req, res) {
  const access = await requireCapability(req, res, CAP.PEOPLE);
  if (!access) return;
  const admin = access.email;

  if (req.method === "GET") {
    try {
      return res.json({ roles: await listRoles(), available: ROLES });
    } catch (err) {
      console.error("Could not load roles:", err);
      return res.status(502).json({ error: "Could not load roles" });
    }
  }

  if (req.method === "PATCH") {
    const email = normalizeEmail(req.body?.email);
    const role = String(req.body?.role || "");

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }
    if (!isRole(role)) {
      return res
        .status(400)
        .json({ error: `Role must be one of: ${ROLES.join(", ")}` });
    }
    if (email === admin) {
      return res
        .status(400)
        .json({ error: "You can't change your own role" });
    }
    if (isEnvAdmin(email)) {
      return res.status(400).json({
        error:
          "That address is an admin via the ADMIN_EMAILS environment variable and can't be changed here",
      });
    }

    try {
      await setRole(email, clampRole(role));
    } catch (err) {
      console.error("Could not save the role:", err);
      return res.status(502).json({ error: "Could not save the role" });
    }
    await logAction(admin, "role.set", `${email} → ${role}`);
    return res.json({ ok: true, email, role });
  }

  res.setHeader("Allow", "GET, PATCH");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
