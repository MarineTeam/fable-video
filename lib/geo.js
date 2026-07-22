// Geo-location whitelisting.
//
// Two independent whitelists, both env-var-based (edited directly in
// Vercel — no dependency on the app itself being reachable), each gated by
// its own Redis-backed enforcement toggle (Settings tab, off by default):
//
// - GEO_WHITELIST — when its toggle (geoEnabled) is on, restricts the whole
//   site (including login) to these countries.
// - ADMIN_GEO_WHITELIST — a bypass list: when its toggle (adminGeoEnabled)
//   is on, a visitor from one of these countries always gets through,
//   regardless of GEO_WHITELIST. This exists so an admin traveling to a
//   country outside GEO_WHITELIST isn't locked out of the whole site
//   (including /admin) — they add their current country here directly in
//   Vercel's env vars and redeploy, which works even when they can't reach
//   the app at all to flip a Redis-backed setting.
//
// Both lists are read-only from the app's side — the Settings tab only
// displays them (see pages/api/admin/settings.js), it never edits them.
import { getGeoSettings } from "./store";

function parseCountryList(raw) {
  return (raw || "")
    .split(",")
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
}

export function normalizeCountryCode(code) {
  return String(code || "").trim().toUpperCase();
}

export function geoWhitelist() {
  return parseCountryList(process.env.GEO_WHITELIST);
}

export function adminGeoWhitelist() {
  return parseCountryList(process.env.ADMIN_GEO_WHITELIST);
}

// A missing/unrecognized country code (local dev, non-Vercel hosting, or a
// visitor Vercel couldn't geolocate) is allowed through rather than
// blocked — the header simply isn't available to check in those cases. An
// empty whitelist also means "no restriction," not "block everyone."
export function isAllowedCountry(countryCode, allowedCodes) {
  if (!allowedCodes.length) return true;
  if (!countryCode) return true;
  return allowedCodes.includes(normalizeCountryCode(countryCode));
}

// Pure decision function: given a resolved country code, the two
// enforcement toggles, and the two whitelists, decides whether the request
// is let through. Kept side-effect free and synchronous so it's testable
// without touching Redis or env vars.
export function resolveGeoAccess({
  countryCode,
  geoEnabled,
  geoWhitelist: allowed,
  adminGeoEnabled,
  adminGeoWhitelist: adminAllowed,
}) {
  if (adminGeoEnabled && countryCode && adminAllowed.length) {
    if (adminAllowed.includes(normalizeCountryCode(countryCode))) return true;
  }
  if (geoEnabled) {
    return isAllowedCountry(countryCode, allowed);
  }
  return true;
}

const CACHE_TTL_MS = 5000;
let cache = null;
let cachedAt = 0;

// Cached per warm serverless instance for a few seconds so the enforcement
// toggles don't cost a Redis round trip on every single request — same
// trade-off as the video-list cache in lib/bunny.js. An admin flipping a
// toggle can take up to CACHE_TTL_MS to reach a given instance.
//
// Fails open: this runs on every request to every page (proxy.js is the
// network boundary), so a Redis error here must never block the whole
// site — unlike approval, which fails closed because that check gates
// access to private content. See lib/guard.js's requireApproved /
// lib/ratelimit.js's allowRequest for the same fail-open-vs-closed
// reasoning.
export async function getGeoEnforcement() {
  const now = Date.now();
  if (cache && now - cachedAt < CACHE_TTL_MS) return cache;
  try {
    cache = await getGeoSettings();
    cachedAt = now;
    return cache;
  } catch (err) {
    console.error("Could not load geo-restriction settings:", err);
    return { geoEnabled: false, adminGeoEnabled: false };
  }
}
