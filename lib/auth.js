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
