// One-click admin maintenance: permanently deletes share links that are no
// longer live (expired past their app-level expiresAt, or soft-revoked) and
// the bundle pages left holding zero live items. Both linger in Redis for
// up to GRACE_SECONDS (30 days, see lib/shares.js / lib/bundles.js) purely
// so Extend/Restore keeps working, not because anyone still needs them —
// this route is "empty that backlog now" instead of waiting out the grace
// window. Re-derives everything fresh from listShares() each call rather
// than trusting any client-supplied ids, so it's safe to run repeatedly.
import { requireAdmin } from "../../../lib/guard";
import { isShareLive, listShares, permanentlyDeleteShares } from "../../../lib/shares";
import { deleteBundlesById } from "../../../lib/bundles";
import { logAction } from "../../../lib/audit";

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const shares = await listShares();

    // Same grouping the admin UI's bundle-pages view already derives
    // client-side (see SharesTab's bundleGroups) — a bundle is never a
    // second source of truth, so "stale" here means every member share is
    // no longer live, not any state stored on the bundle itself.
    const bundleGroups = new Map();
    shares.forEach((share) => {
      if (!share.bundleId) return;
      const group = bundleGroups.get(share.bundleId) || {
        id: share.bundleId,
        email: share.email,
        live: 0,
      };
      if (isShareLive(share)) group.live += 1;
      bundleGroups.set(share.bundleId, group);
    });
    const staleBundles = [...bundleGroups.values()].filter((g) => g.live === 0);

    const staleShareIds = shares.filter((s) => !isShareLive(s)).map((s) => s.id);

    await Promise.all([
      staleShareIds.length ? permanentlyDeleteShares(staleShareIds) : null,
      staleBundles.length ? deleteBundlesById(staleBundles) : null,
    ]);

    await logAction(
      admin,
      "cleanup.stale",
      `Deleted ${staleShareIds.length} stale share link(s) and ${staleBundles.length} empty bundle page(s)`
    );

    return res.json({
      deletedShares: staleShareIds.length,
      deletedBundles: staleBundles.length,
    });
  } catch (err) {
    console.error("Could not clean up stale items:", err);
    return res.status(502).json({ error: "Could not clean up stale items" });
  }
}
