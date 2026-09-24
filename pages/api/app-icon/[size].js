// The app icon at one size: /api/app-icon/180, /192 or /512.
//
// The admin-set icon when there is one (lib/appIcon.js validated it as a PNG
// of exactly this size before it was stored); otherwise a redirect to the
// built-in file, so the URL always answers with an icon.
//
// Public and unauthenticated, like /api/manifest and for the same reason: a
// browser fetches icons before any login exists, and every visitor gets the
// same picture. Excluded from proxy.js's matcher with the other PWA assets.
//
// Caching: a request carrying ?v=<the current version> may be cached for a
// year — the version changes whenever the icon does, so a new icon is a new
// URL. Without one (or with a stale one) it is cached briefly, so a changed
// icon reaches browsers soon.
import { DEFAULT_ICON_PATH, iconSize } from "../../../lib/appIcon";
import { getAppIcon } from "../../../lib/store";
import { oneString } from "../../../lib/params";
import { withMonitorApi } from "../../../lib/monitor";

async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const size = iconSize(oneString(req.query.size));
  if (!size) return res.status(404).json({ error: "Not found" });

  let icon = null;
  try {
    icon = await getAppIcon(size);
  } catch (err) {
    // A cosmetic value: an unreadable icon falls back to the default rather
    // than leaving an install prompt with no picture.
    console.error("Could not read the app icon:", err);
  }

  if (!icon) {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Location", DEFAULT_ICON_PATH[size]);
    res.statusCode = 302;
    return res.end();
  }

  const current = oneString(req.query.v) === icon.version;
  res.setHeader("Content-Type", "image/png");
  // Belt and braces for a file served to anyone from this origin: the bytes
  // were checked to be a PNG, and the browser is told not to guess otherwise.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.setHeader(
    "Cache-Control",
    current ? "public, max-age=31536000, immutable" : "public, max-age=300"
  );
  res.setHeader("Content-Length", String(icon.bytes.length));
  res.statusCode = 200;
  return res.end(req.method === "HEAD" ? undefined : icon.bytes);
}

export default withMonitorApi(handler);
