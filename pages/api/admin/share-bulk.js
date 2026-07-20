// Bulk-share several videos with several recipients in one request. Creates
// one independently-revocable share link per {video, recipient} pair — the
// cross product — and, when email delivery is configured, sends each
// recipient exactly one email listing only their own links. Rate-limited
// like a single share creation.
import { requireAdmin } from "../../../lib/guard";
import { allowRequest } from "../../../lib/ratelimit";
import { getVideo } from "../../../lib/bunny";
import { isValidEmail, normalizeEmail } from "../../../lib/auth";
import { createShares, shareUrl, updateShare } from "../../../lib/shares";
import { emailEnabled, sendBulkShareEmail } from "../../../lib/email";
import { logAction } from "../../../lib/audit";

const MAX_VIDEOS = 25;
const MAX_RECIPIENTS = 25;
const MAX_PAIRS = 200;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const videoIds = Array.isArray(req.body?.videoIds)
    ? [...new Set(req.body.videoIds.filter((id) => typeof id === "string" && id))]
    : [];
  const emails = Array.isArray(req.body?.emails)
    ? [...new Set(req.body.emails.map(normalizeEmail).filter(Boolean))]
    : [];
  const hours = req.body?.hours;
  const shouldEmail = req.body?.sendEmail !== false;

  if (!videoIds.length) {
    return res.status(400).json({ error: "Select at least one video" });
  }
  if (videoIds.length > MAX_VIDEOS) {
    return res.status(400).json({ error: `Select at most ${MAX_VIDEOS} videos at once` });
  }
  if (!emails.length || emails.some((e) => !isValidEmail(e))) {
    return res.status(400).json({ error: "Enter at least one valid recipient email" });
  }
  if (emails.length > MAX_RECIPIENTS) {
    return res.status(400).json({ error: `Enter at most ${MAX_RECIPIENTS} recipients at once` });
  }
  const pairCount = videoIds.length * emails.length;
  if (pairCount > MAX_PAIRS) {
    return res.status(400).json({
      error: `That's ${pairCount} links — narrow videos or recipients to ${MAX_PAIRS} or fewer pairs`,
    });
  }

  if (!(await allowRequest("share", admin, 30, "1 h"))) {
    return res
      .status(429)
      .json({ error: "Too many share links created — try again shortly" });
  }

  let videos;
  try {
    videos = await Promise.all(videoIds.map((id) => getVideo(id)));
  } catch (err) {
    console.error("Video not found:", err);
    return res.status(404).json({ error: "One or more selected videos could not be found" });
  }

  const pairs = [];
  videos.forEach((video, i) => {
    emails.forEach((email) => {
      pairs.push({ videoId: videoIds[i], videoTitle: video.title || "Untitled", email });
    });
  });

  let created;
  try {
    created = await createShares(pairs, { hours, createdBy: admin });
  } catch (err) {
    console.error("Could not create the share links:", err);
    return res.status(502).json({ error: "Could not create the share links" });
  }

  // Group by recipient so each person gets exactly one email listing only
  // their own links, never anyone else's.
  const byRecipient = new Map();
  created.forEach(({ id, share }) => {
    const list = byRecipient.get(share.email) || [];
    list.push({
      id,
      videoTitle: share.videoTitle,
      url: shareUrl(req, id),
      expiresAt: share.expiresAt,
    });
    byRecipient.set(share.email, list);
  });

  const emailResults = {};
  if (shouldEmail && emailEnabled()) {
    await Promise.all(
      Array.from(byRecipient.entries()).map(async ([recipient, links]) => {
        try {
          await sendBulkShareEmail({ recipient, links });
          const emailedAt = new Date().toISOString();
          await Promise.all(
            links.map((l) => updateShare(l.id, { emailedAt }).catch(() => {}))
          );
          emailResults[recipient] = { emailed: true };
        } catch (err) {
          emailResults[recipient] = {
            emailed: false,
            error: err?.message || "Email delivery failed",
          };
        }
      })
    );
  }

  await logAction(
    admin,
    "share.bulk_create",
    `${created.length} link(s): ${videoIds.length} video(s) → ${emails.length} recipient(s)`
  );

  return res.status(201).json({
    created: created.length,
    videos: videoIds.length,
    recipients: emails.length,
    emailConfigured: emailEnabled(),
    emailResults,
  });
}
