// Active share links: list (with viewed + emailed status and exact expiry),
// revocation, restoration, and permanent deletion — a single link via ?id=,
// or several at once via a JSON body { ids: [...] } (used by the Shares
// tab's multi-select actions). DELETE defaults to a soft, recoverable
// revoke; pass { permanent: true } to delete the record outright instead.
// PATCH undoes a soft revoke in place — same id/URL, no new link. Every
// action is idempotent-ish: revoking an id that's already gone still
// reports success, it just has nothing left to do. Bulk never fails the
// whole batch on one bad id — each id gets its own result, and a Redis
// error on one link doesn't stop the rest from being processed.
import { requireAdmin } from "../../../lib/guard";
import {
  listShares,
  permanentlyDeleteShare,
  revokeShare,
  rollupShareAnalyticsByVideo,
  shareUrl,
  unrevokeShare,
} from "../../../lib/shares";
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
        // Per-video rollup of the same tracking data, keyed for the Videos
        // tab's inline "Stats" panel — no extra Redis reads, just a
        // different view of the list already fetched above.
        rollup: rollupShareAnalyticsByVideo(shares),
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
    // Default action is a soft, recoverable revoke. `permanent` skips that
    // and deletes the record outright — used both directly and to finish
    // off a link that's already been soft-revoked.
    const permanent = req.body?.permanent === true || req.query.permanent === "1";

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
          if (permanent) await permanentlyDeleteShare(id);
          else await revokeShare(id);
          results[id] = { ok: true };
        } catch (err) {
          console.error("Could not revoke share link:", err);
          results[id] = {
            ok: false,
            error: `Could not ${permanent ? "delete" : "revoke"} this link`,
          };
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
      const verb = permanent ? "Permanently deleted" : "Revoked";
      await logAction(
        admin,
        permanent ? "share.delete" : "share.revoke",
        ids.length === 1
          ? detail || ids[0]
          : `${verb} ${succeededIds.length}/${ids.length} link(s)${detail ? `: ${detail}` : ""}`
      );
    }

    if (ids.length === 1) {
      const only = results[ids[0]];
      if (!only.ok) return res.status(502).json({ error: only.error });
      return res.json({ ok: true });
    }
    return res.json({ results });
  }

  if (req.method === "PATCH") {
    // Un-revoke — restores a soft-revoked link in place (same id/URL).
    const singleId = String(req.query.id || "");
    const bulkIds = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.filter((v) => typeof v === "string" && v))]
      : [];
    const ids = singleId ? [singleId] : bulkIds;

    if (!ids.length) {
      return res.status(400).json({ error: "Select at least one share link to restore" });
    }
    if (ids.length > MAX_IDS) {
      return res.status(400).json({ error: `Restore at most ${MAX_IDS} links at once` });
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
          const outcome = await unrevokeShare(id);
          if (!outcome.ok) {
            results[id] = {
              ok: false,
              error:
                outcome.error === "not_revoked"
                  ? "This link isn't revoked"
                  : "Link not found (past its grace window, or deleted)",
            };
            return;
          }
          results[id] = { ok: true };
        } catch (err) {
          console.error("Could not restore share link:", err);
          results[id] = { ok: false, error: "Could not restore this link" };
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
        "share.unrevoke",
        ids.length === 1
          ? detail || ids[0]
          : `Restored ${succeededIds.length}/${ids.length} link(s)${detail ? `: ${detail}` : ""}`
      );
    }

    if (ids.length === 1) {
      const only = results[ids[0]];
      if (!only.ok) return res.status(404).json({ error: only.error });
      return res.json({ ok: true });
    }
    return res.json({ results });
  }

  res.setHeader("Allow", "GET, DELETE, PATCH");
  return res.status(405).json({ error: "Method not allowed" });
}
