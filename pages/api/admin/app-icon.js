// Sets or resets the app icon. SETTINGS_MANAGE, like the site name: it is how
// the portal presents itself on every device, not library management.
//
//   PUT    { icons: { 180: base64, 192: base64, 512: base64 } }  -> { version }
//   DELETE                                                        -> back to the built-in icon
//
// The browser resizes; this route trusts none of it — lib/appIcon.js checks
// every size is a PNG of exactly that size, under a byte cap, before anything
// is stored.
import { requireCapability } from "../../../lib/guard";
import { CAP } from "../../../lib/roles";
import { validateIconSet } from "../../../lib/appIcon";
import { clearAppIcons, setAppIcons } from "../../../lib/store";
import { logAction } from "../../../lib/audit";
import { withMonitorApi } from "../../../lib/monitor";

// Three base64 PNGs, capped at ~700KB decoded together; the default 1MB
// body limit is too tight for that once base64 and JSON are added.
export const config = { api: { bodyParser: { sizeLimit: "1.5mb" } } };

async function handler(req, res) {
  const access = await requireCapability(req, res, CAP.SETTINGS_MANAGE);
  if (!access) return;

  if (req.method === "PUT") {
    const result = validateIconSet(req.body?.icons);
    if (!result.ok) return res.status(400).json({ error: result.error });
    try {
      const version = await setAppIcons(result.icons);
      await logAction(access.email, "settings.app_icon", `set ${version}`);
      return res.json({ version });
    } catch (err) {
      console.error("Could not save the app icon:", err);
      return res.status(502).json({ error: "Could not save the icon" });
    }
  }

  if (req.method === "DELETE") {
    try {
      await clearAppIcons();
      await logAction(access.email, "settings.app_icon", "reset to default");
      return res.json({ ok: true });
    } catch (err) {
      console.error("Could not reset the app icon:", err);
      return res.status(502).json({ error: "Could not reset the icon" });
    }
  }

  res.setHeader("Allow", "PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
