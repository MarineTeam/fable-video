// One video's "Private list" — the always-current set of people who have a
// share created *through this panel* for this specific video, managed from
// a single persistent panel instead of the general Videos-tab Share flow.
// Adding an email that's already on the list is a no-op (no duplicate
// share, no re-sent email); removing an email revokes every live
// this-panel-created share it has for this video immediately (soft revoke,
// same as the Shares tab); re-inviting a removed email later is a fresh
// share, same as everywhere else in the app.
//
// Deliberately scoped to shares tagged privateList: true (see buildShare in
// lib/shares.js): a share to the same video+email made via the ad hoc
// Share/Bulk Share flows is a separate, independently-revocable record that
// this panel never lists, never counts as "already on the list," and never
// touches on Remove. Two different admin actions targeting the same person
// and video stay two different shares — this panel only ever manages the
// ones it made itself. Rides entirely on the existing shares hash
// (lib/shares.js) — this route adds no new stored data of its own, just one
// extra field on the records it creates.
import { requireCapability } from "../../../lib/guard";
import { CAP } from "../../../lib/roles";
import { allowRequest } from "../../../lib/ratelimit";
import { getVideo } from "../../../lib/bunny";
import { isValidEmail, normalizeEmail } from "../../../lib/auth";
import {
  createShares,
  groupSharesByEmail,
  listPrivateListSharesForVideo,
  revokeShares,
  shareUrl,
  stampShares,
} from "../../../lib/shares";
import { bundleUrl, ensureBundleForRecipient, liveBundleItems } from "../../../lib/bundles";
import { emailEnabled, sendBulkShareEmail, sendShareEmail } from "../../../lib/email";
import { logAction } from "../../../lib/audit";
import { clampWatermarkMode } from "../../../lib/watermark";
import { withMonitorApi } from "../../../lib/monitor";

const MAX_EMAILS = 25;

async function handler(req, res) {
  const access = await requireCapability(req, res, CAP.SHARES);
  if (!access) return;
  const admin = access.email;

  const videoId = String(req.query.videoId || req.body?.videoId || "");
  if (!videoId) {
    return res.status(400).json({ error: "videoId is required" });
  }

  if (req.method === "GET") {
    try {
      const live = await listPrivateListSharesForVideo(videoId);
      return res.json({ entries: groupSharesByEmail(live) });
    } catch (err) {
      console.error("Could not load the private list:", err);
      return res.status(502).json({ error: "Could not load the private list" });
    }
  }

  if (req.method === "POST") {
    const emails = Array.isArray(req.body?.emails)
      ? [...new Set(req.body.emails.map(normalizeEmail).filter(Boolean))]
      : [];
    const hours = req.body?.hours;
    const shouldEmail = req.body?.sendEmail !== false;
    const watermark = clampWatermarkMode(req.body?.watermark);

    if (!emails.length || emails.some((e) => !isValidEmail(e))) {
      return res.status(400).json({ error: "Enter at least one valid email" });
    }
    if (emails.length > MAX_EMAILS) {
      return res.status(400).json({ error: `Add at most ${MAX_EMAILS} people at once` });
    }

    if (!(await allowRequest("share", admin, 30, "1 h"))) {
      return res
        .status(429)
        .json({ error: "Too many share links created — try again shortly" });
    }

    let video;
    try {
      video = await getVideo(videoId);
    } catch (err) {
      console.error("Video not found:", err);
      return res.status(404).json({ error: "Video not found" });
    }

    let already;
    try {
      already = new Set((await listPrivateListSharesForVideo(videoId)).map((s) => s.email));
    } catch (err) {
      console.error("Could not load the private list:", err);
      return res.status(502).json({ error: "Could not load the private list" });
    }
    const newEmails = emails.filter((e) => !already.has(e));
    const skipped = emails.filter((e) => already.has(e));

    let created = [];
    if (newEmails.length) {
      try {
        created = await createShares(
          newEmails.map((email) => ({
            videoId,
            videoTitle: video.title || "Untitled",
            email,
          })),
          { hours, createdBy: admin, watermark, privateList: true }
        );
      } catch (err) {
        console.error("Could not create share link(s):", err);
        return res.status(502).json({ error: "Could not add the new people" });
      }
    }

    // Bundle-aware notification, mirroring share.js/share-bulk.js exactly:
    // each newly-added recipient gets attached to (or graduated into) their
    // one cross-video bundle, and the email sent is the consolidated bundle
    // email once they have 2+ live shares overall, not just a plain
    // single-link email. Best-effort and never fails the share creation
    // itself.
    const emailResults = {};
    const emailedIds = [];
    const createdById = Object.fromEntries(created.map(({ id, share }) => [id, share]));
    const bundleIdByRecipient = new Map();
    await Promise.all(
      created.map(async ({ id, share }) => {
        const recipient = share.email;
        let bundle = null;
        try {
          bundle = await ensureBundleForRecipient({ email: recipient, newShareIds: [id], hours });
        } catch (err) {
          console.error("Could not update the recipient's bundle:", err);
        }
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
            await sendBulkShareEmail({ recipient, links, bundleUrl: bundleUrl(req, bundle.id) });
          } else {
            await sendShareEmail({
              recipient,
              videoTitle: share.videoTitle,
              url: shareUrl(req, id),
              expiresAt: share.expiresAt,
            });
          }
          emailedIds.push(id);
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
      "share.list_add",
      `${video.title || videoId}: added ${created.length}/${emails.length}` +
        (skipped.length ? ` (${skipped.length} already on the list)` : "")
    );

    return res.status(201).json({
      added: created.map(({ id, share }) => ({
        id,
        email: share.email,
        expiresAt: share.expiresAt,
      })),
      skipped,
      emailConfigured: emailEnabled(),
      emailResults,
    });
  }

  if (req.method === "DELETE") {
    const email = normalizeEmail(req.body?.email || req.query.email || "");
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "A valid email is required" });
    }

    let existing;
    try {
      existing = await listPrivateListSharesForVideo(videoId);
    } catch (err) {
      console.error("Could not load the private list:", err);
      return res.status(502).json({ error: "Could not load the private list" });
    }
    const matches = existing.filter((s) => s.email === email);
    if (!matches.length) {
      return res.status(404).json({ error: "That person isn't on this video's list" });
    }

    try {
      await revokeShares(matches.map((s) => s.id));
    } catch (err) {
      console.error("Could not revoke share link(s):", err);
      return res.status(502).json({ error: "Could not remove this person" });
    }

    await logAction(admin, "share.list_remove", `${matches[0].videoTitle} → ${email}`);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
