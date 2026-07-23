// Send (or resend) the delivery email for one or more existing share links —
// used from the Shares tab for links created before email was configured,
// links whose first send failed, or recipients who lost the email. Accepts
// a single { id } (unchanged response shape, used by the row-level
// Email/Resend button) or a bulk { ids: [...] } (per-id success/failure
// results, used by the multi-select "Resend selected" action) — a bad id
// never blocks the rest of the batch.
//
// If a selected link belongs to a bundle, it resends the consolidated
// bundle email (every currently-live link for that recipient) rather than a
// single-link email — same reason share creation does: never a new
// standalone email once someone has a bundle. When a bulk resend selects
// several rows that share one bundled recipient, only one email actually
// goes out for that recipient (grouped before sending), not one per row.
//
// Share lookups are one batch HMGET for every selected id (lib/shares.js's
// getShares), and the post-send emailedAt stamp is one batch HSETEX
// (stampShares) covering every successfully-emailed id — no per-id Redis
// call in either direction, since every record involved is already in
// memory from the initial batch read.
import { requireAdmin } from "../../../lib/guard";
import { getShares, isShareLive, shareUrl, stampShares } from "../../../lib/shares";
import { bundleUrl, getBundle, liveBundleItems } from "../../../lib/bundles";
import { emailEnabled, sendBulkShareEmail, sendShareEmail } from "../../../lib/email";
import { logAction } from "../../../lib/audit";

const MAX_IDS = 100;

async function resendForRecipient(req, { email, primaryId, share, bundle }) {
  if (bundle) {
    const items = await liveBundleItems(bundle, share.bundleId);
    const links = items.map((it) => ({
      videoTitle: it.videoTitle,
      url: shareUrl(req, it.id),
      expiresAt: it.expiresAt,
    }));
    await sendBulkShareEmail({
      recipient: email,
      links,
      bundleUrl: bundleUrl(req, share.bundleId),
    });
  } else {
    await sendShareEmail({
      recipient: email,
      videoTitle: share.videoTitle,
      url: shareUrl(req, primaryId),
      expiresAt: share.expiresAt,
    });
  }
}

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

  const ids = Array.isArray(req.body?.ids)
    ? [...new Set(req.body.ids.filter((id) => typeof id === "string" && id))]
    : typeof req.body?.id === "string" && req.body.id
      ? [req.body.id]
      : [];

  if (!ids.length) {
    return res.status(400).json({ error: "Select at least one share link to email" });
  }
  if (ids.length > MAX_IDS) {
    return res.status(400).json({ error: `Email at most ${MAX_IDS} links at once` });
  }

  // One batch read for every selected id — a missing or expired link never
  // blocks emailing the rest of the batch, it's just marked ineligible.
  const results = {};
  const shares = {};
  let found;
  try {
    found = await getShares(ids);
  } catch (err) {
    console.error("Could not look up share link(s) for resend:", err);
    return res.status(502).json({ error: "Could not look up the selected link(s)" });
  }
  ids.forEach((id) => {
    const share = found[id];
    if (!share) {
      results[id] = { ok: false, error: "Link not found" };
      return;
    }
    if (!isShareLive(share)) {
      results[id] = { ok: false, error: "Link has expired — extend it before emailing it" };
      return;
    }
    shares[id] = share;
  });

  // Group the still-eligible ids by recipient so a bundle recipient with
  // several selected rows gets exactly one email, not one per row.
  const byRecipient = new Map();
  Object.entries(shares).forEach(([id, share]) => {
    const group = byRecipient.get(share.email) || [];
    group.push(id);
    byRecipient.set(share.email, group);
  });

  const emailedAt = new Date().toISOString();
  let succeeded = 0;
  // Collected across every recipient group and stamped in ONE batch write
  // after all sends settle, instead of a get+set per id per group.
  const emailedShares = {};

  await Promise.all(
    Array.from(byRecipient.entries()).map(async ([email, groupIds]) => {
      const primaryId = groupIds[0];
      const primaryShare = shares[primaryId];
      const bundle = primaryShare.bundleId
        ? await getBundle(primaryShare.bundleId).catch(() => null)
        : null;
      try {
        await resendForRecipient(req, { email, primaryId, share: primaryShare, bundle });
        groupIds.forEach((id) => {
          emailedShares[id] = shares[id];
          results[id] = { ok: true, emailedAt };
          succeeded += 1;
        });
      } catch (err) {
        console.error("Could not email share link(s):", err);
        const message = err?.message || "Email delivery failed";
        groupIds.forEach((id) => {
          results[id] = { ok: false, error: message };
        });
      }
    })
  );

  if (Object.keys(emailedShares).length) {
    await stampShares(emailedShares, { emailedAt }).catch((err) => {
      console.error("Could not stamp emailedAt on share link(s):", err);
    });
  }

  if (succeeded > 0) {
    await logAction(
      admin,
      "share.email",
      `Emailed ${succeeded}/${ids.length} link(s) to ${byRecipient.size} recipient(s)`
    );
  }

  // Preserve the original single-id response shape for the row-level
  // Email/Resend button.
  if (ids.length === 1) {
    const only = results[ids[0]];
    if (!only.ok) {
      const status =
        only.error === "Link not found"
          ? 404
          : only.error.startsWith("Link has expired")
            ? 400
            : 502;
      return res.status(status).json({ error: only.error });
    }
    return res.json({ ok: true, emailedAt: only.emailedAt });
  }

  return res.json({ results });
}
