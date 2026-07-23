// Extends one or more share links' expiry in place — same id/URL, no new
// link, no re-notification (the missing symmetric counterpart to revoke).
// Accepts a single { id, hours } or a bulk { ids: [...], hours }; every id
// gets its own success/failure result. Works on an already-expired-but-
// not-revoked link (extends "from now"); a revoked link still has a record
// (see lib/shares.js's soft revoke) but is refused explicitly, so extending
// can never double as a silent un-revoke — restore it first via PATCH
// /api/admin/shares.
//
// One Redis read (batch HMGET) + one write (batch HSETEX) for the whole
// selection via lib/shares.js's extendShares, instead of a get+set per id.
// Bundle TTLs are extended once per UNIQUE bundle among the successfully
// extended shares, not once per share — extending 50 shares that all
// belong to the same bundle used to call extendBundleTtl 50 times
// redundantly.
import { requireAdmin } from "../../../lib/guard";
import { extendShares } from "../../../lib/shares";
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

  let outcomes;
  try {
    outcomes = await extendShares(ids, hours);
  } catch (err) {
    console.error("Could not extend share link(s):", err);
    return res.status(502).json({ error: "Could not extend the selected link(s)" });
  }

  const results = {};
  ids.forEach((id) => {
    const outcome = outcomes[id];
    if (!outcome.ok) {
      results[id] = {
        ok: false,
        error:
          outcome.error === "revoked"
            ? "Link is revoked — restore it first"
            : "Link not found (revoked, or past its grace window)",
      };
      return;
    }
    results[id] = { ok: true, expiresAt: outcome.share.expiresAt };
  });

  const succeededIds = ids.filter((id) => results[id].ok);
  if (succeededIds.length) {
    const bundleIds = new Set(
      succeededIds.map((id) => outcomes[id].share.bundleId).filter(Boolean)
    );
    await Promise.all([...bundleIds].map((bundleId) => extendBundleTtl(bundleId, hours)));

    await logAction(
      admin,
      "share.extend",
      `Extended ${succeededIds.length}/${ids.length} link(s) by ${hours || "default"} hour(s)`
    );
  }

  return res.json({ results });
}
