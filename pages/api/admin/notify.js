// Manual admin broadcast: send a Web Push notification to every currently
// approved viewer (and admins). Rate-limited and audit-logged.
import { requireAdmin } from "../../../lib/guard";
import { allowRequest } from "../../../lib/ratelimit";
import { pushEnabled, sendPushToApproved } from "../../../lib/push";
import { logAction } from "../../../lib/audit";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (!pushEnabled()) {
    return res.status(503).json({ error: "Push notifications are not configured" });
  }

  if (!(await allowRequest("notify", admin, 10, "1 h"))) {
    return res.status(429).json({ error: "Too many broadcasts — try again shortly" });
  }

  const title = String(req.body?.title || "").trim();
  const message = String(req.body?.body || "").trim();
  const rawUrl = String(req.body?.url || "/").trim();
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
