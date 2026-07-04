// Send (or resend) the delivery email for an existing share link — used from
// the Shares tab for links created before email was configured, links whose
// first send failed, or recipients who lost the email.
import { requireAdmin } from "../../../lib/guard";
import { getShare, shareUrl, updateShare } from "../../../lib/shares";
import { emailEnabled, sendShareEmail } from "../../../lib/email";
import { logAction } from "../../../lib/audit";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (!emailEnabled()) {
    return res.status(400).json({
      error: "Email delivery is not configured (set RESEND_API_KEY and EMAIL_FROM)",
    });
  }

  const id = String(req.body?.id || "");
  let share = null;
  try {
    share = await getShare(id);
  } catch {
    return res.status(502).json({ error: "Could not look up the share link" });
  }
  if (!share) {
    return res.status(404).json({ error: "Share link not found or expired" });
  }

  try {
    await sendShareEmail({
      recipient: share.email,
      videoTitle: share.videoTitle,
      url: shareUrl(req, id),
      expiresAt: share.expiresAt,
    });
  } catch (err) {
    return res
      .status(502)
      .json({ error: err?.message || "Email delivery failed" });
  }

  const emailedAt = new Date().toISOString();
  await updateShare(id, { emailedAt }).catch(() => {});
  await logAction(admin, "share.email", `${share.videoTitle} → ${share.email}`);
  return res.json({ ok: true, emailedAt });
}
