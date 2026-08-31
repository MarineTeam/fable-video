// Self-serve access request from a signed-in but unapproved user.
//
// This is the one authenticated endpoint an UNAPPROVED person may call, so
// it deliberately uses requireUser (logged in) rather than requireAccess
// (approved) — and does nothing except record a request for an admin to act
// on. It never grants anything.
//
// The email is taken from the session, never from the body: letting a caller
// name the address they're requesting for would turn this into a way to spam
// the admin queue with other people's addresses.
import { requireUser } from "../../lib/guard";
import { allowRequest } from "../../lib/ratelimit";
import { resolveAccess } from "../../lib/roles";
import {
  MAX_MESSAGE_LENGTH,
  createAccessRequest,
  getAccessRequest,
} from "../../lib/accessRequests";
import { logAction } from "../../lib/audit";
import { withMonitorApi } from "../../lib/monitor";

async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const email = await requireUser(req, res);
  if (!email) return;

  // Tight budget: a request is a human action taken once, and the queue is
  // read by a person.
  if (!(await allowRequest("access-request", email, 5, "1 d"))) {
    return res
      .status(429)
      .json({ error: "Too many access requests — try again tomorrow" });
  }

  const message = String(req.body?.message || "");
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res
      .status(400)
      .json({ error: `Keep your note to ${MAX_MESSAGE_LENGTH} characters or fewer` });
  }

  try {
    // Someone who already has access has nothing to request — say so plainly
    // rather than queueing a request that would confuse the admin.
    const access = await resolveAccess(email);
    if (access.approved) {
      return res.status(400).json({ error: "You already have access" });
    }

    const existing = await getAccessRequest(email);
    if (existing) {
      return res.json({ status: existing.status, alreadyRequested: true });
    }

    const created = await createAccessRequest(email, {
      name: req.body?.name,
      message,
    });
    if (!created) {
      return res.status(500).json({ error: "Could not record your request" });
    }
    // Actor is the requester — this is the one audit entry not written by an
    // admin, and seeing who asked is the point of logging it.
    await logAction(email, "access.request", email);
    return res.json({ status: "pending", alreadyRequested: false });
  } catch (err) {
    console.error("Could not record the access request:", err);
    return res.status(502).json({ error: "Could not record your request" });
  }
}

export default withMonitorApi(handler);
