// Create a private share link for a video, tied to a specific recipient
// email — and, when email delivery is configured, automatically email the
// link to the recipient. Rate-limited.
import { requireAdmin } from "../../../lib/guard";
import { allowRequest } from "../../../lib/ratelimit";
import { getVideo } from "../../../lib/bunny";
import { isValidEmail, normalizeEmail } from "../../../lib/auth";
import { createShare, shareUrl, updateShare } from "../../../lib/shares";
import { emailEnabled, sendShareEmail } from "../../../lib/email";
import { logAction } from "../../../lib/audit";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (!(await allowRequest("share", admin, 30, "1 h"))) {
    return res
      .status(429)
      .json({ error: "Too many share links created — try again shortly" });
  }

  const { videoId, hours } = req.body || {};
  const recipient = normalizeEmail(req.body?.email);
  const shouldEmail = req.body?.sendEmail !== false;

  if (!videoId || typeof videoId !== "string") {
    return res.status(400).json({ error: "videoId is required" });
  }
  if (!isValidEmail(recipient)) {
    return res.status(400).json({ error: "A valid recipient email is required" });
  }

  let video;
  try {
    video = await getVideo(videoId);
  } catch (err) {
    console.error("Video not found:", err);
    return res.status(404).json({ error: "Video not found" });
  }

  let created;
  try {
    created = await createShare({
      videoId,
      videoTitle: video.title || "Untitled",
      email: recipient,
      hours,
      createdBy: admin,
    });
  } catch (err) {
    console.error("Could not create the share link:", err);
    return res.status(502).json({ error: "Could not create the share link" });
  }
  const { id, share } = created;
  const url = shareUrl(req, id);

  // Automatic email delivery — failures never lose the link; the admin can
  // still copy it (or hit "Email link" again from the Shares tab).
  let emailed = false;
  let emailError = null;
  if (shouldEmail && emailEnabled()) {
    try {
      await sendShareEmail({
        recipient,
        videoTitle: share.videoTitle,
        url,
        expiresAt: share.expiresAt,
      });
      await updateShare(id, { emailedAt: new Date().toISOString() }).catch(() => {});
      emailed = true;
    } catch (err) {
      emailError = err?.message || "Email delivery failed";
    }
  }

  await logAction(
    admin,
    "share.create",
    `${share.videoTitle} → ${recipient}${emailed ? " (emailed)" : ""}`
  );

  return res.status(201).json({
    id,
    url,
    expiresAt: share.expiresAt,
    emailed,
    emailError,
    emailConfigured: emailEnabled(),
  });
}
