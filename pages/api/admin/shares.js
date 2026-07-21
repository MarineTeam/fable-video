// Active share links: list (with viewed + emailed status and exact expiry)
// and revocation — a single link via ?id=, or several at once via a JSON
// body { ids: [...] } (used by the Shares tab's multi-select "Revoke
// selected"). Revoke is idempotent, same as before: revoking an id that's
// already gone still reports success, it just has nothing left to do.
// Bulk never fails the whole batch on one bad id — each id gets its own
// result, and a Redis error on one link doesn't stop the rest from being
// revoked.
import { requireAdmin } from "../../../lib/guard";
import { listShares, revokeShare, shareUrl } from "../../../lib/shares";
import { logAction } from "../../../lib/audit";

const MAX_IDS = 100;

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === "GET") {
    try {
      const shares = await listShares();
      return res.json({
        shares: shares.map((share) => ({
          ...share,
          url: shareUrl(req, share.id),
        })),
      });
    } catch (err) {
      console.error("Could not load share links:", err);
      return res.status(502).json({ error: "Could not load share links" });
    }
  }

  if (req.method === "DELETE") {
    const singleId = String(req.query.id || "");
    const bulkIds = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.filter((v) => typeof v === "string" && v))]
      : [];
    const ids = singleId ? [singleId] : bulkIds;

    if (!ids.length) {
      return res.status(400).json({ error: "Select at least one share link to revoke" });
    }
    if (ids.length > MAX_IDS) {
      return res.status(400).json({ error: `Revoke at most ${MAX_IDS} links at once` });
    }

    let byId = new Map();
    try {
      byId = new Map((await listShares()).map((s) => [s.id, s]));
    } catch (err) {
      console.error("Could not load share links:", err);
      return res.status(502).json({ error: "Could not load share links" });
    }

    const results = {};
    await Promise.all(
      ids.map(async (id) => {
        try {
          await revokeShare(id);
          results[id] = { ok: true };
        } catch (err) {
          console.error("Could not revoke share link:", err);
          results[id] = { ok: false, error: "Could not revoke this link" };
        }
      })
    );

    const succeededIds = ids.filter((id) => results[id].ok);
    if (succeededIds.length) {
      const detail = succeededIds
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((s) => `${s.videoTitle} → ${s.email}`)
        .join("; ");
      await logAction(
        admin,
        "share.revoke",
        ids.length === 1
          ? detail || ids[0]
          : `Revoked ${succeededIds.length}/${ids.length} link(s)${detail ? `: ${detail}` : ""}`
      );
    }

    if (ids.length === 1) {
      const only = results[ids[0]];
      if (!only.ok) return res.status(502).json({ error: only.error });
      return res.json({ ok: true });
    }
    return res.json({ results });
  }

  res.setHeader("Allow", "GET, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
