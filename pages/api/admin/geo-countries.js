// Country list for the geo-location whitelist — see lib/geo.js for how it's
// enforced (proxy.js, against Vercel's x-vercel-ip-country header). The
// toggle itself (geoEnabled) lives in /api/admin/settings; this route only
// manages which ISO 3166-1 alpha-2 codes are on the list.
import { requireAdmin } from "../../../lib/guard";
import { isValidCountryCode, normalizeCountryCode } from "../../../lib/geo";
import { addAllowedCountry, listAllowedCountries, removeAllowedCountry } from "../../../lib/store";
import { logAction } from "../../../lib/audit";

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === "GET") {
    try {
      return res.json({ countries: await listAllowedCountries() });
    } catch (err) {
      console.error("Could not load the country whitelist:", err);
      return res.status(502).json({ error: "Could not load the country whitelist" });
    }
  }

  if (req.method === "POST") {
    if (!isValidCountryCode(req.body?.code)) {
      return res
        .status(400)
        .json({ error: "A valid 2-letter country code is required" });
    }
    const code = normalizeCountryCode(req.body.code);
    try {
      await addAllowedCountry(code);
    } catch (err) {
      console.error("Could not add the country:", err);
      return res.status(502).json({ error: "Could not add the country" });
    }
    await logAction(admin, "geo.country_add", code);
    return res.json({ ok: true });
  }

  if (req.method === "DELETE") {
    const code = normalizeCountryCode(req.query.code);
    if (!code) return res.status(400).json({ error: "Country code is required" });
    try {
      await removeAllowedCountry(code);
    } catch (err) {
      console.error("Could not remove the country:", err);
      return res.status(502).json({ error: "Could not remove the country" });
    }
    await logAction(admin, "geo.country_remove", code);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
