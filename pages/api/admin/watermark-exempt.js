// Per-recipient exemption list for the email watermark feature — any email
// (approved viewer or admin) added here never gets a watermark, regardless
// of the global default or any per-video/per-share override (see
// lib/watermark.js's resolveWatermark: exemption always wins).
import { requireAdmin } from "../../../lib/guard";
import { isValidEmail, normalizeEmail } from "../../../lib/auth";
import { listWatermarkExemptions, setWatermarkExemption } from "../../../lib/store";
import { logAction } from "../../../lib/audit";

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === "GET") {
    try {
      return res.json({ exemptions: await listWatermarkExemptions() });
    } catch (err) {
      console.error("Could not load watermark exemptions:", err);
      return res.status(502).json({ error: "Could not load watermark exemptions" });
    }
  }

  if (req.method === "POST") {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    try {
      await setWatermarkExemption(email, true);
    } catch (err) {
      console.error("Could not add the watermark exemption:", err);
      return res.status(502).json({ error: "Could not add the watermark exemption" });
    }
    await logAction(admin, "watermark.exempt_add", email);
    return res.json({ ok: true });
  }

  if (req.method === "DELETE") {
    const email = normalizeEmail(req.query.email);
    if (!email) return res.status(400).json({ error: "Email is required" });
    try {
      await setWatermarkExemption(email, false);
    } catch (err) {
      console.error("Could not remove the watermark exemption:", err);
      return res.status(502).json({ error: "Could not remove the watermark exemption" });
    }
    await logAction(admin, "watermark.exempt_remove", email);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
