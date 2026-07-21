// Create a private share link for a video, tied to a specific recipient
// email — and, when email delivery is configured, automatically email the
// link to the recipient. Rate-limited.
import { requireAdmin } from "../../../lib/guard";
import { allowRequest } from "../../../lib/ratelimit";
import { getVideo } from "../../../lib/bunny";
import { isValidEmail, normalizeEmail } from "../../../lib/auth";
import { createShare, shareUrl, updateShare } from "../../../lib/shares";
import { bundleUrl, ensureBundleForRecipient, liveBundleItems } from "../../../lib/bundles";
import { emailEnabled, sendBulkShareEmail, sendShareEmail } from "../../../lib/email";
import { logAction } from "../../../lib/audit";
import { clampWatermarkMode } from "../../../lib/watermark";

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
  const watermark = clampWatermarkMode(req.body?.watermark);

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
      watermark,
    });
  } catch (err) {
    console.error("Could not create the share link:", err);
    return res.status(502).json({ error: "Could not create the share link" });
  }
  const { id, share } = created;
  const url = shareUrl(req, id);

  // One bundle per recipient: attach this new share to their existing
  // bundle, or create one (sweeping in any other already-live shares) once
  // they cross 2 active shares. Best-effort — grouping must never fail
  // share creation itself.
  let bundle = null;
  try {
    bundle = await ensureBundleForRecipient({ email: recipient, newShareIds: [id], hours });
  } catch (err) {
    console.error("Could not update the recipient's bundle:", err);
  }

  // Automatic email delivery — failures never lose the link; the admin can
  // still copy it (or hit "Email link" again from the Shares tab). Once a
  // bundle exists, every notification becomes one consolidated email
  // listing everything currently live for that recipient, not just this
  // one new link.
  let emailed = false;
  let emailError = null;
  if (shouldEmail && emailEnabled()) {
    try {
      if (bundle?.bundle) {
        const items = await liveBundleItems(bundle.bundle, bundle.id);
        const links = items.map((it) => ({
          videoTitle: it.videoTitle,
          url: shareUrl(req, it.id),
          expiresAt: it.expiresAt,
        }));
        await sendBulkShareEmail({ recipient, links, bundleUrl: bundleUrl(req, bundle.id) });
      } else {
        await sendShareEmail({
          recipient,
          videoTitle: share.videoTitle,
          url,
          expiresAt: share.expiresAt,
        });
      }
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
    bundle: bundle?.bundle ? { id: bundle.id, url: bundleUrl(req, bundle.id) } : null,
  });
}
