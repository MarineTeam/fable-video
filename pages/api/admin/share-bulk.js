// Bulk-share several videos with several recipients in one request. Creates
// one independently-revocable share link per {video, recipient} pair — the
// cross product — and, when email delivery is configured, sends each
// recipient exactly one email. A bad video id never fails the whole batch:
// it's skipped and reported, and the rest still get shared. Rate-limited
// like a single share creation.
import { requireAdmin } from "../../../lib/guard";
import { allowRequest } from "../../../lib/ratelimit";
import { getVideo } from "../../../lib/bunny";
import { isValidEmail, normalizeEmail } from "../../../lib/auth";
import { createShares, shareUrl, updateShare } from "../../../lib/shares";
import { bundleUrl, ensureBundleForRecipient, liveBundleItems } from "../../../lib/bundles";
import { emailEnabled, sendBulkShareEmail, sendShareEmail } from "../../../lib/email";
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

  // Look up every video individually so one missing/deleted video doesn't
  // fail the whole batch — it's skipped and reported back instead.
  const videoLookups = await Promise.all(
    videoIds.map(async (id) => {
      try {
        const video = await getVideo(id);
        return { id, title: video.title || "Untitled", ok: true };
      } catch (err) {
        console.error("Video not found:", err);
        return { id, ok: false };
      }
    })
  );
  const validVideos = videoLookups.filter((v) => v.ok);
  const skippedVideoIds = videoLookups.filter((v) => !v.ok).map((v) => v.id);
  if (!validVideos.length) {
    return res.status(404).json({ error: "None of the selected videos could be found" });
  }

  const pairs = [];
  validVideos.forEach((video) => {
    emails.forEach((email) => {
      pairs.push({ videoId: video.id, videoTitle: video.title, email });
    });
  });

  let created;
  try {
    created = await createShares(pairs, { hours, createdBy: admin });
  } catch (err) {
    console.error("Could not create the share links:", err);
    return res.status(502).json({ error: "Could not create the share links" });
  }

  // Group by recipient — every person gets exactly one bundle update and
  // one email, never anyone else's links.
  const byRecipient = new Map();
  created.forEach(({ id, share }) => {
    const ids = byRecipient.get(share.email) || [];
    ids.push(id);
    byRecipient.set(share.email, ids);
  });

  const emailResults = {};
  await Promise.all(
    Array.from(byRecipient.entries()).map(async ([recipient, newShareIds]) => {
      // One bundle per recipient: attach to their existing bundle, or
      // create one (sweeping in other already-live shares) once they cross
      // 2 active shares. Best-effort — never fails the batch.
      let bundle = null;
      try {
        bundle = await ensureBundleForRecipient({ email: recipient, newShareIds, hours });
      } catch (err) {
        console.error("Could not update the recipient's bundle:", err);
      }

      if (!shouldEmail || !emailEnabled()) return;
      try {
        if (bundle?.bundle) {
          const items = await liveBundleItems(bundle.bundle, bundle.id);
          const links = items.map((it) => ({
            videoTitle: it.videoTitle,
            url: shareUrl(req, it.id),
            expiresAt: it.expiresAt,
          }));
          await sendBulkShareEmail({
            recipient,
            links,
            bundleUrl: bundleUrl(req, bundle.id),
          });
        } else {
          // Genuinely this recipient's first and only active share.
          const only = created.find((c) => c.share.email === recipient);
          await sendShareEmail({
            recipient,
            videoTitle: only.share.videoTitle,
            url: shareUrl(req, only.id),
            expiresAt: only.share.expiresAt,
          });
        }
        const emailedAt = new Date().toISOString();
        await Promise.all(
          newShareIds.map((id) => updateShare(id, { emailedAt }).catch(() => {}))
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

  await logAction(
    admin,
    "share.bulk_create",
    `${created.length} link(s): ${validVideos.length} video(s) → ${emails.length} recipient(s)` +
      (skippedVideoIds.length ? ` (${skippedVideoIds.length} video(s) skipped)` : "")
  );

  return res.status(201).json({
    created: created.length,
    videos: validVideos.length,
    recipients: emails.length,
    skippedVideoIds,
    emailConfigured: emailEnabled(),
    emailResults,
  });
}
