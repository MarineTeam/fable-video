// Admin settings: homepage video count, plus read-only config state the
// admin panel needs (email delivery configuration, geo-whitelist env vars).
import { requireCapability } from "../../../lib/guard";
import { CAP } from "../../../lib/roles";
import {
  getGeoSettings,
  getPodcastSettings,
  getSettings,
  getWatermarkSettings,
  MAX_VIDEO_COUNT,
  saveAdminGeoEnabled,
  saveGeoEnabled,
  savePodcastEnabled,
  saveSettings,
  saveSiteName,
  saveWatermarkEnabled,
} from "../../../lib/store";
import { mediaEnabled, mp4Height } from "../../../lib/bunnyMedia";
import { emailEnabled, emailFrom } from "../../../lib/email";
import {
  MAX_SITE_NAME_LENGTH,
  envSiteName,
  validateSiteName,
} from "../../../lib/siteName";
import { pushEnabled } from "../../../lib/push";
import {
  adminGeoBypassEmails,
  adminGeoWhitelist,
  geoWhitelist,
} from "../../../lib/geo";
import { logAction } from "../../../lib/audit";
import { withMonitorApi } from "../../../lib/monitor";

async function handler(req, res) {
  const access = await requireCapability(req, res, CAP.SETTINGS);
  if (!access) return;
  const admin = access.email;

  if (req.method === "GET") {
    try {
      const [settings, watermark, geo, podcast] = await Promise.all([
        getSettings(),
        getWatermarkSettings(),
        getGeoSettings(),
        getPodcastSettings(),
      ]);
      return res.json({
        ...settings,
        watermarkEnabled: watermark.enabled,
        geoEnabled: geo.geoEnabled,
        adminGeoEnabled: geo.adminGeoEnabled,
        geoWhitelist: geoWhitelist(),
        adminGeoWhitelist: adminGeoWhitelist(),
        adminGeoBypassEmails: adminGeoBypassEmails(),
        emailConfigured: emailEnabled(),
        emailFrom: emailEnabled() ? emailFrom() : null,
        // getSettings() resolves this: admin-set value, else the env var,
        // else the built-in default. envSiteName is surfaced separately so
        // the panel can say what clearing the field would fall back to.
        envSiteName: envSiteName(),
        maxSiteNameLength: MAX_SITE_NAME_LENGTH,
        pushConfigured: pushEnabled(),
        podcastEnabled: podcast.enabled,
        // The feed can only serve media through the CDN pull zone, and only
        // for videos that actually have an MP4 fallback. Surfaced so the
        // Settings panel can warn rather than let an admin switch on a
        // feature that will hand subscribers 404s.
        podcastMediaReady: mediaEnabled(),
        podcastMp4Height: mp4Height(),
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
    if (body.siteName !== undefined) {
      const problem = validateSiteName(body.siteName);
      if (problem) return res.status(400).json({ error: problem });
      updates.push(["siteName", String(body.siteName).trim()]);
    }
    if (body.watermarkEnabled !== undefined) {
      updates.push(["watermarkEnabled", Boolean(body.watermarkEnabled)]);
    }
    if (body.podcastEnabled !== undefined) {
      updates.push(["podcastEnabled", Boolean(body.podcastEnabled)]);
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
          if (key === "siteName") return saveSiteName(value);
          if (key === "watermarkEnabled") return saveWatermarkEnabled(value);
          if (key === "podcastEnabled") return savePodcastEnabled(value);
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

export default withMonitorApi(handler);
