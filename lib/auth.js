// Centralized identity helpers. Access control everywhere in the app compares
// normalized emails.
//
// ADMIN_EMAILS is the bootstrap admin seed: its members are admins
// unconditionally and cannot be demoted from the UI, so there is always a way
// back into a portal whose Redis role data is broken. Everyone else's role is
// stored in Redis and resolved by lib/roles.js. This module deliberately
// exposes only the ENV half — it stays synchronous and Redis-free so it can
// never fail open on an infra error. Anything asking "is this person an
// admin?" in the general sense wants resolveRole/resolveAccess from
// lib/roles.js, not isEnvAdmin.

export function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

export function adminEmails() {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => normalizeEmail(email))
    .filter(Boolean);
}

// True only for an ADMIN_EMAILS address. A Redis-promoted admin is NOT
// covered here — use resolveRole() from lib/roles.js for the effective role.
export function isEnvAdmin(email) {
  const normalized = normalizeEmail(email);
  return Boolean(normalized) && adminEmails().includes(normalized);
}

// Whether the portal refuses sessions whose Auth0 email claim is unverified.
// Opt-in via REQUIRE_VERIFIED_EMAIL, and deliberately OFF by default: an
// existing portal's viewers may predate the check, and Auth0 connections
// differ in whether they populate the claim at all. Turning it on without
// warning would lock real people out of a live site.
export function verifiedEmailRequired() {
  const raw = (process.env.REQUIRE_VERIFIED_EMAIL || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
}

// Auth0 sends email_verified as a real boolean, but a custom claim or a
// mapped connection can deliver the string "true" — accept both, and treat
// anything else (including a MISSING claim) as unverified. Missing must mean
// unverified: if an absent claim passed, a connection that simply doesn't
// send the field would silently disable the whole check.
export function isEmailVerified(user) {
  const claim = user?.email_verified;
  return claim === true || claim === "true";
}

// The single decision: should this session be refused for an unverified
// email? Pure and Redis-free so it can run in a page gate, an API guard, and
// a unit test identically.
//
// ADMIN_EMAILS addresses are exempt, for the same reason they can't be
// demoted from the UI (see lib/roles.js): they are the recovery path. If
// enforcement is switched on and the bootstrap admin's own claim is missing,
// they must still be able to get in and switch it back off.
export function blockedByEmailVerification(user) {
  if (!verifiedEmailRequired()) return false;
  if (isEnvAdmin(user?.email)) return false;
  return !isEmailVerified(user);
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail(email));
}

// Parses a pasted list of emails separated by commas, semicolons, or
// whitespace/newlines. Returns normalized, deduplicated valid and invalid sets.
export function parseEmailList(raw) {
  const seen = new Set();
  const valid = [];
  const invalid = [];
  for (const piece of String(raw || "").split(/[\s,;]+/)) {
    if (!piece) continue;
    const email = normalizeEmail(piece);
    if (seen.has(email)) continue;
    seen.add(email);
    if (isValidEmail(email)) valid.push(email);
    else invalid.push(email);
  }
  return { valid, invalid };
}
