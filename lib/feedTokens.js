// Per-subscriber podcast feed tokens.
//
// ── What a token is, and what it is NOT ───────────────────────────────────
//
// A token is an IDENTITY CLAIM and nothing else. It answers exactly one
// question — "which account is asking?" — and answers it in place of a session
// cookie, because podcast apps cannot log in.
//
// It is NOT an entitlement. Holding a token grants nothing by itself.
// Approval, role, group video scope and publish/expiry windows are all
// re-resolved from Redis on EVERY feed fetch and EVERY episode download, by
// the same code paths the website uses (resolveAccess + fetchVideoLibrary).
//
// The consequence is the property worth having: removing someone from the
// viewer list, restricting their group, or expiring a video ends their feed on
// their app's next poll, with no separate revocation step and nothing to
// remember to do. There is no cached entitlement anywhere to go stale.
//
// Regeneration exists for the other case — a token that leaked. Issuing a new
// one deletes the old, and the old URL stops resolving immediately.
//
// ── Size ──────────────────────────────────────────────────────────────────
//
// 256 bits from crypto.randomBytes, base64url. These URLs live in podcast
// apps, get synced between devices, and are never rotated on a schedule, so
// they are sized to be permanently unguessable rather than merely
// inconvenient. 43 characters is a small price for a URL nobody types.
import crypto from "crypto";
import { k, redis } from "./redis";
import { normalizeEmail } from "./auth";

export const TOKEN_BYTES = 32; // 256 bits

// token -> email, and email -> token. Two hashes because both directions are
// hot: the feed route has a token and needs the email, and the viewer's own
// page has their email and needs to show them their URL.
const byTokenKey = () => k("feed", "tokens");
const byEmailKey = () => k("feed", "byemail");

export function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

// Shape check before Redis is touched, so a junk path costs nothing and a
// malformed token can never be used to probe for a key.
export function isFeedToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

// Resolves a token to an email. Returns null for an unknown or malformed
// token AND for any Redis failure — fail closed: an infra error must never
// resolve to somebody.
export async function emailForToken(token) {
  if (!isFeedToken(token)) return null;
  try {
    const email = await redis().hget(byTokenKey(), token);
    return email ? normalizeEmail(email) : null;
  } catch (err) {
    console.error("Could not resolve a feed token:", err);
    return null;
  }
}

export async function getFeedToken(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const token = await redis().hget(byEmailKey(), normalized);
  return isFeedToken(token) ? token : null;
}

// Returns the caller's existing token, minting one on first use. Issuing a
// token is not a grant, so there is nothing to approve here — an unapproved
// caller simply gets a URL whose every fetch will deny them.
export async function ensureFeedToken(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const existing = await getFeedToken(normalized);
  if (existing) return existing;
  return rotateFeedToken(normalized);
}

// Issues a fresh token and invalidates the previous one. The old token is
// removed FIRST-class rather than left orphaned: a stale token→email row is a
// working feed URL, so it must not survive a rotation.
export async function rotateFeedToken(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const r = redis();
  const previous = await r.hget(byEmailKey(), normalized);
  const token = generateToken();
  await r.hset(byTokenKey(), { [token]: normalized });
  await r.hset(byEmailKey(), { [normalized]: token });
  if (previous && previous !== token) {
    await r.hdel(byTokenKey(), previous).catch(() => {});
  }
  return token;
}

// Called when a viewer is removed. Strictly speaking it is not required —
// their feed would deny on the next fetch anyway, because entitlement is
// re-resolved every time — but leaving a token→email row for someone who no
// longer exists is dead state that invites someone later to "optimize" the
// feed by trusting it. Delete it and keep the invariant obvious.
export async function deleteFeedToken(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  const r = redis();
  const token = await r.hget(byEmailKey(), normalized).catch(() => null);
  await Promise.all([
    token ? r.hdel(byTokenKey(), token).catch(() => {}) : Promise.resolve(),
    r.hdel(byEmailKey(), normalized).catch(() => {}),
  ]);
}

// The subscriber's feed URL, or null when APP_BASE_URL isn't configured.
export function feedUrl(token) {
  const base = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  if (!base || !isFeedToken(token)) return null;
  return `${base}/api/feed/${token}`;
}
