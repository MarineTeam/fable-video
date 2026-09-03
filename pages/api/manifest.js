// Serves the PWA manifest — rewritten to this route from /manifest.webmanifest
// by next.config.js, so the URL every browser and the service worker already
// know about is unchanged. What changes is that the name and short_name now
// come from the admin-set site name in Redis instead of a static file frozen
// at build time, so a rename can actually reach an install prompt or an
// already-installed app (subject to how often each browser re-checks an
// installed app's manifest — that schedule is the browser's, not ours).
//
// Public and unauthenticated on purpose, same reasoning as pages/api/theme.js
// GET: proxy.js's matcher excludes this path entirely (PWA assets bypass
// session/geo checks — see proxy.js's config.matcher), and a manifest is
// fetched by the browser before any login state exists. It is not
// user-specific: every visitor gets the same document, so there is nothing
// here to leak.
//
// A read failure falls back to the built-in default — same fail-open
// reasoning as every other site-name read in this app: a cosmetic value must
// never break the manifest and take PWA installability down with it.
import { getSiteName } from "../../lib/store";
import { resolveSiteName, shortSiteName } from "../../lib/siteName";
import { withMonitorApi } from "../../lib/monitor";

async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let name;
  try {
    name = await getSiteName();
  } catch (err) {
    console.error("Could not load the site name for the manifest:", err);
    name = resolveSiteName(null);
  }

  // The spec MIME type; set it explicitly rather than relying on res.json()'s
  // default, since we want application/manifest+json, not application/json.
  res.setHeader("Content-Type", "application/manifest+json");
  return res.json({
    name,
    short_name: shortSiteName(name),
    description: "Private, invite-only video portal.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  });
}

export default withMonitorApi(handler);
