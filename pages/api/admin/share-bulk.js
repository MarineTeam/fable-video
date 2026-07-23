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
import { createShares, shareUrl, stampShares } from "../../../lib/shares";
import { bundleUrl, ensureBundleForRecipient, liveBundleItems } from "../../../lib/bundles";
import { emailEnabled, sendBulkShareEmail, sendShareEmail } from "../../../lib/email";
import { logAction } from "../../../lib/audit";
import { clampWatermarkMode } from "../../../lib/watermark";

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
  const watermark = clampWatermarkMode(req.body?.watermark);

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
    created = await createShares(pairs, { hours, createdBy: admin, watermark });
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
  // Surfaced back to the admin UI so a durable "Copy bundle link" button
  // can be shown per recipient right in the create-links result, not just
  // buried in the email that recipient receives.
  const bundleResults = {};
  const createdById = Object.fromEntries(created.map(({ id, share }) => [id, share]));
  // ensureBundleForRecipient (below) may tag a newly-created share with a
  // bundleId in Redis; track it per recipient here so the final stamp can
  // merge it in locally instead of re-reading — otherwise stamping from the
  // pre-bundle-tag createdById copy would clobber bundleId back to null.
  const bundleIdByRecipient = new Map();
  // Collected across every recipient group, stamped in ONE batch write
  // after all sends settle, instead of a get+set per share per group.
  const emailedIds = [];
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
      bundleResults[recipient] = bundle?.bundle
        ? { id: bundle.id, url: bundleUrl(req, bundle.id) }
        : null;
      if (bundle?.bundle) bundleIdByRecipient.set(recipient, bundle.id);

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
        emailedIds.push(...newShareIds);
        emailResults[recipient] = { emailed: true };
      } catch (err) {
        emailResults[recipient] = {
          emailed: false,
          error: err?.message || "Email delivery failed",
        };
      }
    })
  );

  if (emailedIds.length) {
    const emailedAt = new Date().toISOString();
    const toStamp = Object.fromEntries(
      emailedIds.map((id) => {
        const share = createdById[id];
        const bundleId = bundleIdByRecipient.get(share.email);
        return [id, bundleId ? { ...share, bundleId } : share];
      })
    );
    await stampShares(toStamp, { emailedAt }).catch((err) => {
      console.error("Could not stamp emailedAt on share link(s):", err);
    });
  }

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
    bundleResults,
  });
}
