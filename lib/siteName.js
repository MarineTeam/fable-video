// The portal's display name.
//
// Resolution order, most specific first:
//   1. the admin-set value in Redis (k("settings") field "siteName")
//   2. SITE_NAME / NEXT_PUBLIC_SITE_NAME from the environment
//   3. the built-in default
//
// This module is PURE and storage-free so client components can import it —
// lib/store.js reaches into Redis, and importing that from a component would
// pull server-only code into the browser bundle (the same split as
// lib/capabilities.js vs lib/roles.js).
//
// The name is resolved SERVER-side and passed down as a prop rather than
// fetched on mount like the palette. A colour arriving a moment late is a
// flicker; a brand name arriving late means every visitor reads the wrong
// name in the tab title and header on first paint, and search/link previews
// scraping the page would see the wrong one entirely.

export const DEFAULT_SITE_NAME = "Marine Video Portal";

// Long enough for a real organisation name, short enough to stay on one line
// in the header and not blow out an email subject.
export const MAX_SITE_NAME_LENGTH = 60;

// NEXT_PUBLIC_SITE_NAME must be referenced literally: Next inlines
// process.env.NEXT_PUBLIC_* at build time by static text substitution, so a
// computed lookup would silently resolve to undefined in the browser.
// SITE_NAME is server-only and simply reads as undefined on the client, which
// is why both are checked here rather than one being "the" variable.
export function envSiteName() {
  const serverValue =
    typeof process !== "undefined" ? process.env.SITE_NAME : undefined;
  const publicValue = process.env.NEXT_PUBLIC_SITE_NAME;
  return clean(serverValue) || clean(publicValue) || "";
}

function clean(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.length > MAX_SITE_NAME_LENGTH
    ? text.slice(0, MAX_SITE_NAME_LENGTH).trim()
    : text;
}

// Turns whatever is stored (or null, or junk) into a usable name. Never
// returns an empty string — an empty header and a bare "—" page title are
// worse than a default nobody chose.
export function resolveSiteName(stored) {
  return clean(stored) || envSiteName() || DEFAULT_SITE_NAME;
}

// Validates an admin-submitted name. Returns an error string, or null when
// the name is usable.
export function validateSiteName(value) {
  const text = String(value ?? "").trim();
  if (!text) return "Site name can't be empty";
  if (text.length > MAX_SITE_NAME_LENGTH) {
    return `Site name must be ${MAX_SITE_NAME_LENGTH} characters or fewer`;
  }
  return null;
}

// One place that builds "<page> — <site>", so renaming the site can't leave a
// stale suffix behind on some page nobody remembered. Pass no part (or an
// empty one) to get the bare site name.
export function pageTitle(part, siteName) {
  const site = resolveSiteName(siteName);
  const prefix = String(part ?? "").trim();
  return prefix ? `${prefix} — ${site}` : site;
}

// Home-screen labels (the manifest's short_name, iOS's
// apple-mobile-web-app-title) have much less room than a header or a page
// title — platform guidance is to keep these around a dozen characters so a
// launcher doesn't truncate them mid-word. Longer names still work; they're
// just clipped by the OS, the same way they would be for any app.
export const MAX_SHORT_NAME_LENGTH = 12;

export function shortSiteName(siteName) {
  const site = resolveSiteName(siteName);
  return site.length > MAX_SHORT_NAME_LENGTH
    ? site.slice(0, MAX_SHORT_NAME_LENGTH).trim()
    : site;
}
