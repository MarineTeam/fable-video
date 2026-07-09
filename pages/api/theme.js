// Site palette. GET is public (it only exposes two accent colors, needed
// pre-approval for the "not approved" page to render themed). POST is
// admin-only and applies to all visitors.
import { requireAdmin } from "../../lib/guard";
import { getTheme, saveTheme } from "../../lib/store";
import { isValidHex, PRESETS, resolveTheme } from "../../lib/theme";
import { logAction } from "../../lib/audit";

export default async function handler(req, res) {
  if (req.method === "GET") {
    let stored = null;
    try {
      stored = await getTheme();
    } catch (err) {
      console.error("Could not load the palette, falling back to default:", err);
    }
    return res.json({ theme: resolveTheme(stored) });
  }

  if (req.method === "POST") {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const body = req.body || {};
    let theme;
    if (body.preset === "custom") {
      if (!isValidHex(body.accent) || !isValidHex(body.accent2)) {
        return res
          .status(400)
          .json({ error: "Custom colors must be #RRGGBB hex values" });
      }
      theme = {
        preset: "custom",
        accent: body.accent.toLowerCase(),
        accent2: body.accent2.toLowerCase(),
      };
    } else if (PRESETS[body.preset]) {
      theme = { preset: body.preset };
    } else {
      return res.status(400).json({ error: "Unknown palette" });
    }

    try {
      await saveTheme(theme);
    } catch (err) {
      console.error("Could not save the palette:", err);
      return res.status(502).json({ error: "Could not save the palette" });
    }
    await logAction(
      admin,
      "theme.update",
      theme.preset === "custom"
        ? `custom (${theme.accent} / ${theme.accent2})`
        : theme.preset
    );
    return res.json({ theme: resolveTheme(theme) });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
