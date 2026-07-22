// Admin settings: homepage video count, plus read-only config state the
// admin panel needs (email delivery configuration, geo-whitelist env vars).
import { requireAdmin } from "../../../lib/guard";
import {
  getGeoSettings,
  getSettings,
  getWatermarkSettings,
  MAX_VIDEO_COUNT,
  saveAdminGeoEnabled,
  saveGeoEnabled,
  saveSettings,
  saveWatermarkEnabled,
} from "../../../lib/store";
import { emailEnabled, emailFrom, siteName } from "../../../lib/email";
import { pushEnabled } from "../../../lib/push";
import { adminGeoWhitelist, geoWhitelist } from "../../../lib/geo";
import { logAction } from "../../../lib/audit";

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === "GET") {
    try {
      const [settings, watermark, geo] = await Promise.all([
        getSettings(),
        getWatermarkSettings(),
        getGeoSettings(),
      ]);
      return res.json({
        ...settings,
        watermarkEnabled: watermark.enabled,
        geoEnabled: geo.geoEnabled,
        adminGeoEnabled: geo.adminGeoEnabled,
        geoWhitelist: geoWhitelist(),
        adminGeoWhitelist: adminGeoWhitelist(),
        emailConfigured: emailEnabled(),
        emailFrom: emailEnabled() ? emailFrom() : null,
        siteName: siteName(),
        pushConfigured: pushEnabled(),
      });
    } catch (err) {
      console.error("Could not load settings:", err);
      return res.status(502).json({ error: "Could not load settings" });
    }
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const updates = [];

    if (body.videoCount !== undefined) {
      const videoCount = Number(body.videoCount);
      if (
        !Number.isFinite(videoCount) ||
        videoCount < 1 ||
        videoCount > MAX_VIDEO_COUNT
      ) {
        return res
          .status(400)
          .json({ error: `Video count must be between 1 and ${MAX_VIDEO_COUNT}` });
      }
      updates.push(["videoCount", Math.floor(videoCount)]);
    }
    if (body.watermarkEnabled !== undefined) {
      updates.push(["watermarkEnabled", Boolean(body.watermarkEnabled)]);
    }
    if (body.geoEnabled !== undefined) {
      updates.push(["geoEnabled", Boolean(body.geoEnabled)]);
    }
    if (body.adminGeoEnabled !== undefined) {
      updates.push(["adminGeoEnabled", Boolean(body.adminGeoEnabled)]);
    }
    if (!updates.length) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    try {
      await Promise.all(
        updates.map(([key, value]) => {
          if (key === "watermarkEnabled") return saveWatermarkEnabled(value);
          if (key === "geoEnabled") return saveGeoEnabled(value);
          if (key === "adminGeoEnabled") return saveAdminGeoEnabled(value);
          return saveSettings({ [key]: value });
        })
      );
    } catch (err) {
      console.error("Could not save settings:", err);
      return res.status(502).json({ error: "Could not save settings" });
    }
    await logAction(
      admin,
      "settings.update",
      updates.map(([key, value]) => `${key} → ${value}`).join(", ")
    );
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
