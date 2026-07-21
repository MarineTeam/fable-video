// Extends one or more share links' expiry in place — same id/URL, no new
// link, no re-notification (the missing symmetric counterpart to revoke).
// Accepts a single { id, hours } or a bulk { ids: [...], hours }; bulk
// never fails the whole batch on one bad id — every id gets its own
// success/failure result. Works on an already-expired-but-not-revoked link
// (extends "from now"); a revoked link has no record left to extend, so it
// naturally comes back not_found rather than being silently un-revoked.
import { requireAdmin } from "../../../lib/guard";
import { extendShare } from "../../../lib/shares";
import { extendBundleTtl } from "../../../lib/bundles";
import { logAction } from "../../../lib/audit";

const MAX_IDS = 100;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const ids = Array.isArray(req.body?.ids)
    ? [...new Set(req.body.ids.filter((id) => typeof id === "string" && id))]
    : typeof req.body?.id === "string" && req.body.id
      ? [req.body.id]
      : [];
  const hours = req.body?.hours;

  if (!ids.length) {
    return res.status(400).json({ error: "Select at least one share link to extend" });
  }
  if (ids.length > MAX_IDS) {
    return res.status(400).json({ error: `Extend at most ${MAX_IDS} links at once` });
  }

  const results = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const outcome = await extendShare(id, hours);
        if (!outcome.ok) {
          results[id] = { ok: false, error: "Link not found (revoked, or past its grace window)" };
          return;
        }
        results[id] = { ok: true, expiresAt: outcome.share.expiresAt };
        if (outcome.share.bundleId) {
          await extendBundleTtl(outcome.share.bundleId, hours);
        }
      } catch (err) {
        console.error("Could not extend share link:", err);
        results[id] = { ok: false, error: "Could not extend this link" };
      }
    })
  );

  const succeeded = Object.values(results).filter((r) => r.ok).length;
  if (succeeded > 0) {
    await logAction(
      admin,
      "share.extend",
      `Extended ${succeeded}/${ids.length} link(s) by ${hours || "default"} hour(s)`
    );
  }

  return res.json({ results });
}
