// The admin side of self-serve access requests: read the queue, then approve
// (adds the viewer and clears the request), deny (keeps the record so the
// person doesn't reappear in the queue), or delete (which lets them ask
// again).
//
// People management, so CAP.PEOPLE — a manager can run the library but never
// decides who gets into it.
import { requireCapability } from "../../../lib/guard";
import { CAP } from "../../../lib/roles";
import { isValidEmail, normalizeEmail } from "../../../lib/auth";
import {
  denyAccessRequest,
  deleteAccessRequest,
  getAccessRequest,
  listAccessRequests,
} from "../../../lib/accessRequests";
import { addViewers } from "../../../lib/store";
import { logAction } from "../../../lib/audit";
import { withMonitorApi } from "../../../lib/monitor";

async function handler(req, res) {
  const access = await requireCapability(req, res, CAP.PEOPLE);
  if (!access) return;
  const admin = access.email;

  if (req.method === "GET") {
    try {
      return res.json({ requests: await listAccessRequests() });
    } catch (err) {
      console.error("Could not load access requests:", err);
      return res.status(502).json({ error: "Could not load access requests" });
    }
  }

  if (req.method === "POST") {
    const email = normalizeEmail(req.body?.email);
    const decision = String(req.body?.decision || "");
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }
    if (decision !== "approve" && decision !== "deny") {
      return res.status(400).json({ error: "Decision must be approve or deny" });
    }

    try {
      const existing = await getAccessRequest(email);
      if (!existing) return res.status(404).json({ error: "Request not found" });

      if (decision === "approve") {
        // Add the viewer FIRST, then clear the request. If the second step
        // fails, the person has access and a stale queue entry an admin can
        // dismiss — the opposite order could drop the request while granting
        // nothing.
        await addViewers([email], admin);
        await deleteAccessRequest(email);
        await logAction(admin, "access.approve", email);
        return res.json({ ok: true, decision });
      }

      await denyAccessRequest(email, admin);
      await logAction(admin, "access.deny", email);
      return res.json({ ok: true, decision });
    } catch (err) {
      console.error("Could not decide the access request:", err);
      return res.status(502).json({ error: "Could not save that decision" });
    }
  }

  if (req.method === "DELETE") {
    const email = normalizeEmail(req.query.email);
    if (!email) return res.status(400).json({ error: "Email is required" });
    let removed;
    try {
      removed = await deleteAccessRequest(email);
    } catch (err) {
      console.error("Could not delete the access request:", err);
      return res.status(502).json({ error: "Could not delete that request" });
    }
    if (!removed) return res.status(404).json({ error: "Request not found" });
    // Dismissing a denial is what lets that person ask again.
    await logAction(admin, "access.dismiss", email);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
