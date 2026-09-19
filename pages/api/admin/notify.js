// Manual admin broadcast: send a Web Push notification to every currently
// approved viewer (and admins). Rate-limited and audit-logged.
import { requireCapability } from "../../../lib/guard";
import { oneString, oneTrimmed } from "../../../lib/params";
import { CAP } from "../../../lib/roles";
import { allowRequest } from "../../../lib/ratelimit";
import { pushEnabled, sendPushToApproved } from "../../../lib/push";
import { logAction } from "../../../lib/audit";
import { withMonitorApi } from "../../../lib/monitor";

async function handler(req, res) {
  // Guard BEFORE the method check, like every other admin route. Checking the
  // method first answered an unauthorised caller with 405 "Method not
  // allowed", which confirms the route exists and names the verb it wants —
  // this was the only route in the repo doing so.
  const access = await requireCapability(req, res, CAP.BROADCAST_SEND);
  if (!access) return;
  const admin = access.email;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!pushEnabled()) {
    return res.status(503).json({ error: "Push notifications are not configured" });
  }

  if (!(await allowRequest("notify", admin, 10, "1 h"))) {
    return res.status(429).json({ error: "Too many broadcasts — try again shortly" });
  }

  const title = oneTrimmed(req.body?.title) || "";
  const message = oneTrimmed(req.body?.body) || "";
  const rawUrl = oneTrimmed(req.body?.url) || "/";
  // Only allow same-origin paths as the click target — never an external URL.
  const url = rawUrl.startsWith("/") ? rawUrl : "/";

  if (!title || title.length > 100) {
    return res.status(400).json({ error: "Title must be 1-100 characters" });
  }
  if (message.length > 300) {
    return res.status(400).json({ error: "Message must be at most 300 characters" });
  }

  let result;
  try {
    result = await sendPushToApproved({ title, body: message, url });
  } catch (err) {
    console.error("Broadcast failed:", err);
    return res.status(502).json({ error: "Broadcast failed" });
  }

  await logAction(admin, "push.broadcast", `${title} → ${result.sent} recipient(s)`);
  return res.json({ ok: true, sent: result.sent, pruned: result.pruned });
}

export default withMonitorApi(handler);
