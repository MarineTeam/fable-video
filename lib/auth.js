// Centralized identity helpers. Access control everywhere in the app compares
// normalized emails; admins come from the ADMIN_EMAILS environment variable.

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

export function isAdmin(email) {
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
