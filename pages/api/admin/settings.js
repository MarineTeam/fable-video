// Admin settings: homepage video count, plus read-only config state the
// admin panel needs (email delivery configuration).
import { requireAdmin } from "../../../lib/guard";
import { getSettings, MAX_VIDEO_COUNT, saveSettings } from "../../../lib/store";
import { emailEnabled, emailFrom, siteName } from "../../../lib/email";
import { logAction } from "../../../lib/audit";

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === "GET") {
    try {
      const settings = await getSettings();
      return res.json({
        ...settings,
        emailConfigured: emailEnabled(),
        emailFrom: emailEnabled() ? emailFrom() : null,
        siteName: siteName(),
      });
    } catch (err) {
      console.error("Could not load settings:", err);
      return res.status(502).json({ error: "Could not load settings" });
    }
  }

  if (req.method === "POST") {
    const videoCount = Number(req.body?.videoCount);
    if (
      !Number.isFinite(videoCount) ||
      videoCount < 1 ||
      videoCount > MAX_VIDEO_COUNT
    ) {
      return res
        .status(400)
        .json({ error: `Video count must be between 1 and ${MAX_VIDEO_COUNT}` });
    }
    try {
      await saveSettings({ videoCount: Math.floor(videoCount) });
    } catch (err) {
      console.error("Could not save settings:", err);
      return res.status(502).json({ error: "Could not save settings" });
    }
    await logAction(admin, "settings.update", `video count → ${Math.floor(videoCount)}`);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
