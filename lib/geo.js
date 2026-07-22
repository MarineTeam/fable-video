// Geo-location whitelist. Admin-managed from the Settings tab (Redis-backed
// via lib/store.js, like other live-editable settings — no redeploy needed).
// Enforced in proxy.js against Vercel's `x-vercel-ip-country` request header,
// so it only takes effect once deployed on Vercel's edge network.
import { getGeoSettings, listAllowedCountries } from "./store";

export function normalizeCountryCode(code) {
  return String(code || "").trim().toUpperCase();
}

export function isValidCountryCode(code) {
  return /^[A-Za-z]{2}$/.test(String(code || "").trim());
}

// A missing/unrecognized country code (local dev, non-Vercel hosting, or a
// visitor Vercel couldn't geolocate) is allowed through rather than
// blocked — the header simply isn't available to check in those cases.
export function isAllowedCountry(countryCode, allowedCodes) {
  const allowed = new Set((allowedCodes || []).map(normalizeCountryCode));
  if (allowed.size === 0) return true;
  if (!countryCode) return true;
  return allowed.has(normalizeCountryCode(countryCode));
}

// Restriction only takes effect once the toggle is on AND at least one
// country is whitelisted — an enabled-but-empty list blocks nobody rather
// than blocking everybody.
export function geoRestrictionActive(config) {
  return Boolean(config?.enabled) && (config?.countries?.length || 0) > 0;
}

const CACHE_TTL_MS = 5000;
let cache = null;
let cachedAt = 0;

// Cached per warm serverless instance for a few seconds so the geo check
// doesn't cost a Redis round trip on every single request — same trade-off
// as the video-list cache in lib/bunny.js. An admin toggling the setting or
// editing the country list can take up to CACHE_TTL_MS to reach a given
// instance.
//
// Fails open: this runs on every request to every page (proxy.js is the
// network boundary), so a Redis error here must never block the whole site —
// unlike approval, which fails closed because that check gates access to
// private content. See lib/guard.js's requireApproved / lib/ratelimit.js's
// allowRequest for the same fail-open-vs-closed reasoning.
export async function getGeoConfig() {
  const now = Date.now();
  if (cache && now - cachedAt < CACHE_TTL_MS) return cache;
  try {
    const [settings, countries] = await Promise.all([
      getGeoSettings(),
      listAllowedCountries(),
    ]);
    cache = { enabled: settings.enabled, countries };
    cachedAt = now;
    return cache;
  } catch (err) {
    console.error("Could not load geo-restriction config:", err);
    return { enabled: false, countries: [] };
  }
}
