// Approved viewer management: list (with last-seen), add (single or bulk
// paste — validated and deduped), and remove.
import { requireAdmin } from "../../../lib/guard";
import { normalizeEmail, parseEmailList } from "../../../lib/auth";
import { addViewers, listViewers, removeViewer } from "../../../lib/store";
import { logAction } from "../../../lib/audit";

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === "GET") {
    try {
      return res.json({ viewers: await listViewers() });
    } catch (err) {
      console.error("Could not load viewers:", err);
      return res.status(502).json({ error: "Could not load viewers" });
    }
  }

  if (req.method === "POST") {
    const raw = req.body?.emails;
    const { valid, invalid } = parseEmailList(
      Array.isArray(raw) ? raw.join(",") : raw
    );
    if (!valid.length) {
      return res
        .status(400)
        .json({ error: "No valid email addresses found", invalid });
    }
    let added = 0;
    try {
      added = await addViewers(valid, admin);
    } catch (err) {
      console.error("Could not save viewers:", err);
      return res.status(502).json({ error: "Could not save viewers" });
    }
    if (added > 0) {
      await logAction(
        admin,
        "viewer.add",
        added === 1 ? valid[0] : `${added} viewers`
      );
    }
    return res.json({
      added,
      skippedExisting: valid.length - added,
      invalid,
    });
  }

  if (req.method === "DELETE") {
    const email = normalizeEmail(req.query.email);
    if (!email) return res.status(400).json({ error: "Email is required" });
    try {
      await removeViewer(email);
    } catch (err) {
      console.error("Could not remove viewer:", err);
      return res.status(502).json({ error: "Could not remove viewer" });
    }
    await logAction(admin, "viewer.remove", email);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
