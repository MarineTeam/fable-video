// Optional geo-fencing, inert until ALLOWED_COUNTRIES is set (comma-separated
// ISO 3166-1 alpha-2 codes, e.g. "US,CA"). Country is read from Vercel's
// `x-vercel-ip-country` request header in proxy.js, so this only takes effect
// once deployed on Vercel's edge network.

export function allowedCountries() {
  return new Set(
    (process.env.ALLOWED_COUNTRIES || "")
      .split(",")
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean)
  );
}

export function geoRestrictionEnabled() {
  return allowedCountries().size > 0;
}

// A missing/unknown country code (local dev, non-Vercel hosting, or a client
// Vercel didn't geolocate) is allowed through rather than blocked — the
// header simply isn't available to check in those cases.
export function isAllowedCountry(countryCode) {
  const allowed = allowedCountries();
  if (allowed.size === 0) return true;
  if (!countryCode) return true;
  return allowed.has(String(countryCode).trim().toUpperCase());
}
