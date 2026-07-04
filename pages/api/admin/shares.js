// Active share links: list (with viewed + emailed status and exact expiry)
// and instant revocation.
import { requireAdmin } from "../../../lib/guard";
import { listShares, revokeShare, shareUrl } from "../../../lib/shares";
import { logAction } from "../../../lib/audit";

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
    } catch {
      return res.status(502).json({ error: "Could not load share links" });
    }
  }

  if (req.method === "DELETE") {
    const id = String(req.query.id || "");
    if (!id) return res.status(400).json({ error: "Share id is required" });
    let share = null;
    try {
      const all = await listShares();
      share = all.find((s) => s.id === id) || null;
      await revokeShare(id);
    } catch {
      return res.status(502).json({ error: "Could not revoke the share link" });
    }
    await logAction(
      admin,
      "share.revoke",
      share ? `${share.videoTitle} → ${share.email}` : id
    );
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
