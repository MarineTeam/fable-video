// Bundles group a recipient's share links into one page. A bundle is a
// PURE grouping list — an email, an expiry, and a list of share ids — never
// a second source of truth for any item's title or status. Every read of a
// bundle re-fetches each member share live (liveBundleItems), so revoking
// or letting one item expire is reflected instantly with no bundle write.
//
// One bundle per recipient: looked up by email via a pointer key, not by
// scanning. Opening the bundle page uses the exact same gate as an
// individual share (Auth0 forced login + normalized-email match, see
// pages/watch/bundle/[bundleId].js) — because that gate is a single Auth0
// session cookie shared across every page on this origin, verifying once
// for the bundle page already covers every individual item's page too; no
// separate per-item re-verification step exists to unify.
import crypto from "crypto";
import { k, redis } from "./redis";
import {
  clampShareHours,
  getShares,
  isShareLive,
  listSharesForEmail,
  stampShares,
} from "./shares";

const bundleKey = (id) => k("bundle", id);
const emailPointerKey = (email) => k("bundle-email", email);

// Same physical-TTL-outlives-app-expiry grace window as shares (lib/shares.js)
// — a bundle record must never be deleted before its members can still be
// individually extended and re-swept in.
const GRACE_SECONDS = 30 * 24 * 3600;

export function isBundleId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(id);
}

export async function getBundle(id) {
  if (!isBundleId(id)) return null;
  return (await redis().get(bundleKey(id))) || null;
}

// Looks up the recipient's one active bundle, if any. Prunes a stale
// email -> bundle pointer whose bundle record has already fallen out of its
// grace window (defensive; normally both keys share a TTL and expire together).
export async function getBundleForEmail(email) {
  const r = redis();
  const id = await r.get(emailPointerKey(email));
  if (!id) return null;
  const bundle = await getBundle(id);
  if (!bundle) {
    await r.del(emailPointerKey(email)).catch(() => {});
    return null;
  }
  return { id, bundle };
}

async function writeBundle(id, bundle, ttlSeconds) {
  const r = redis();
  await Promise.all([
    r.set(bundleKey(id), bundle, { ex: ttlSeconds }),
    r.set(emailPointerKey(bundle.email), id, { ex: ttlSeconds }),
  ]);
}

// One HMGET + one HSETEX(KEEPTTL) for the whole item list, instead of a
// get+set per item — see lib/shares.js's header comment for why batching
// through the shares hash costs a flat 2 commands regardless of size.
async function tagSharesWithBundle(itemIds, bundleId) {
  if (!itemIds.length) return;
  try {
    const found = await getShares(itemIds);
    const toTag = Object.fromEntries(
      Object.entries(found).filter(([, share]) => share)
    );
    await stampShares(toTag, { bundleId });
  } catch {
    // Best-effort, same as the per-item version this replaced.
  }
}

export async function createBundle({ email, items, hours }) {
  const id = crypto.randomBytes(16).toString("base64url");
  const ttlHours = clampShareHours(hours);
  const ttlSeconds = ttlHours * 3600;
  const now = Date.now();
  const bundle = {
    email,
    items: [...new Set(items)],
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
  };
  await writeBundle(id, bundle, ttlSeconds + GRACE_SECONDS);
  await tagSharesWithBundle(bundle.items, id);
  return { id, bundle };
}

// Adds items to an existing bundle (no-op for ones already present) and
// extends the bundle's own expiry to at least `hours` from now — never
// shortening it, mirroring how a share's own extend works "from now."
export async function addToBundle(id, newItemIds, hours) {
  const r = redis();
  const key = bundleKey(id);
  const bundle = await r.get(key);
  if (!bundle) return null;

  const items = new Set(bundle.items || []);
  newItemIds.forEach((itemId) => items.add(itemId));

  const ttlHours = clampShareHours(hours);
  const requestedExpiresAt = Date.now() + ttlHours * 3600 * 1000;
  const currentExpiresAt = new Date(bundle.expiresAt).getTime() || 0;
  const nextExpiresAtMs = Math.max(requestedExpiresAt, currentExpiresAt);
  const ttlSeconds = Math.max(1, Math.ceil((nextExpiresAtMs - Date.now()) / 1000));

  const updated = {
    ...bundle,
    items: [...items],
    expiresAt: new Date(nextExpiresAtMs).toISOString(),
  };
  await writeBundle(id, updated, ttlSeconds + GRACE_SECONDS);
  await tagSharesWithBundle(newItemIds, id);
  return updated;
}

// Extends a bundle's expiry to at least `hours` from now — never shortens
// it. Used when an individual member share is extended, so the bundle page
// doesn't lapse before that member does (see pages/api/admin/share-extend.js).
// Best-effort: a bundle extension failure never fails the share extension it
// was triggered by.
export async function extendBundleTtl(id, hours) {
  try {
    return await addToBundle(id, [], hours);
  } catch {
    return null;
  }
}

// Live view of a bundle's contents — the enforcement of "never a second
// source of truth." Re-reads each member share fresh and drops any id whose
// share is gone or app-expired, rather than storing a duplicate status. Also
// opportunistically prunes those dead ids out of the bundle's own item list
// (best-effort, mirrors listShares()'s opportunistic index pruning) so a
// long-lived bundle doesn't accumulate an ever-growing list of dead ids.
export async function liveBundleItems(bundle, id) {
  const ids = bundle?.items || [];
  if (!ids.length) return [];
  // One HMGET for every member id, instead of a GET per item.
  const records = await getShares(ids);
  const live = [];
  const liveIds = [];
  ids.forEach((itemId) => {
    const record = records[itemId];
    if (isShareLive(record)) {
      live.push({ id: itemId, ...record });
      liveIds.push(itemId);
    }
  });
  if (id && liveIds.length !== ids.length) {
    const r = redis();
    const ttl = await r.ttl(bundleKey(id)).catch(() => -1);
    if (ttl > 0) {
      r.set(bundleKey(id), { ...bundle, items: liveIds }, { ex: ttl }).catch(() => {});
    }
  }
  return live;
}

// Enumerates every bundle key currently in Redis via SCAN over the
// bundle:* pattern. Deliberately the one exception to this file's own
// "looked up by email pointer, not by scanning" rule (see header comment)
// — admin cleanup (pages/api/admin/cleanup.js) needs the full set of
// bundles that exist, including ones no share references anymore (e.g. its
// member shares were already permanently deleted one-by-one from the
// Shares tab before this cleanup route existed). Nothing on a per-request
// path may use this; it exists only for that one maintenance action.
export async function scanAllBundleIds() {
  const r = redis();
  const prefix = bundleKey("");
  let cursor = "0";
  const ids = [];
  do {
    const [next, keys] = await r.scan(cursor, { match: `${prefix}*`, count: 200 });
    cursor = next;
    for (const key of keys) ids.push(key.slice(prefix.length));
  } while (cursor !== "0");
  return ids;
}

// Deletes a batch of bundles outright — the bundle record and (carefully)
// its email -> bundle pointer — given the {id, email} pairs an admin
// cleanup pass has already identified as holding zero live items (see
// pages/api/admin/cleanup.js). The pointer is only cleared if it's still
// pointing at the bundle being deleted: a recipient can get a brand-new
// bundle before an old, now-stale one's physical TTL lapses, and a cleanup
// pass targeting the old one must never clobber the new one's pointer.
// Not used by any per-recipient read path: those always go through
// getBundle/getBundleForEmail, which already treat a missing key as
// "no bundle," so deleting one here is safe and final.
export async function deleteBundlesById(entries) {
  if (!entries.length) return 0;
  const r = redis();
  const pointerKeys = entries.map(({ email }) => emailPointerKey(email));
  const currentPointers = await r.mget(...pointerKeys);
  const keysToDelete = entries.map(({ id }) => bundleKey(id));
  entries.forEach(({ id }, i) => {
    if (currentPointers[i] === id) keysToDelete.push(pointerKeys[i]);
  });
  await r.del(...keysToDelete);
  return entries.length;
}

export function bundleUrl(req, id) {
  const base = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  if (base) return `${base}/watch/bundle/${id}`;
  const host = req?.headers?.host;
  return host ? `https://${host}/watch/bundle/${id}` : `/watch/bundle/${id}`;
}

// Given a fresh batch of just-created share ids for one recipient, returns
// the bundle that should now represent them, or null if this recipient
// should still get a plain, non-bundled notification (genuinely their
// first and only active share — see pages/api/admin/share.js /
// share-bulk.js for how the two notification paths branch on this).
//
// - If the recipient already has a bundle: the new items are added to it.
// - Otherwise, if the new items plus their other currently-live shares
//   total 2 or more, a bundle is created sweeping in those other live
//   shares too (covers shares made before bundling existed, or made by an
//   earlier action that didn't itself cross the 2-item threshold).
// - Otherwise (exactly one share, ever): null.
export async function ensureBundleForRecipient({ email, newShareIds, hours }) {
  const existing = await getBundleForEmail(email);
  if (existing) {
    const updated = await addToBundle(existing.id, newShareIds, hours);
    return { id: existing.id, bundle: updated };
  }

  const others = (await listSharesForEmail(email))
    .filter((s) => isShareLive(s) && !newShareIds.includes(s.id))
    .map((s) => s.id);

  if (others.length + newShareIds.length < 2) return null;

  return createBundle({ email, items: [...others, ...newShareIds], hours });
}
