// One-click admin maintenance: permanently deletes share links that are no
// longer live (expired past their app-level expiresAt, or soft-revoked) and
// the bundle pages left holding zero live items. Both linger in Redis for
// up to GRACE_SECONDS (30 days, see lib/shares.js / lib/bundles.js) purely
// so Extend/Restore keeps working, not because anyone still needs them —
// this route is "empty that backlog now" instead of waiting out the grace
// window. Re-derives everything fresh each call rather than trusting any
// client-supplied ids, so it's safe to run repeatedly.
//
// Bundle staleness is checked against each bundle's OWN item list (via a
// full scanAllBundleIds() enumeration), not derived from which shares still
// happen to carry that bundleId. A bundle whose member shares were already
// permanently deleted one-by-one from the Shares tab (e.g. before this
// route existed) has no share left referencing it at all — deriving
// staleness from the shares list alone would make that bundle permanently
// invisible to cleanup. Scanning bundles directly is this route's one
// exception to "look up by pointer, not by scanning" (see lib/bundles.js).
import { requireAdmin } from "../../../lib/guard";
import { getShares, isShareLive, listShares, permanentlyDeleteShares } from "../../../lib/shares";
import { deleteBundlesById, getBundle, scanAllBundleIds } from "../../../lib/bundles";
import { logAction } from "../../../lib/audit";

async function findStaleBundles() {
  const bundleIds = await scanAllBundleIds();
  const checked = await Promise.all(
    bundleIds.map(async (id) => {
      const bundle = await getBundle(id);
      if (!bundle) return null;
      const itemIds = bundle.items || [];
      const records = itemIds.length ? await getShares(itemIds) : {};
      const hasLive = itemIds.some((itemId) => isShareLive(records[itemId]));
      return hasLive ? null : { id, email: bundle.email };
    })
  );
  return checked.filter(Boolean);
}

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const [shares, staleBundles] = await Promise.all([listShares(), findStaleBundles()]);

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
