// Self-serve access requests.
//
// Someone who signs in successfully but isn't on the viewer list can ask for
// access instead of the admin having to know in advance who to add. A request
// is a claim about identity, not a grant: it stores who asked and what they
// said, and nothing about it widens access until an admin approves it.
//
// One record per normalized email, kept in a single hash (k("requests")) so
// listing every pending request costs one Redis command regardless of count —
// the same reason shares live in one hash (see lib/shares.js).
import { k, redis } from "./redis";
import { normalizeEmail } from "./auth";

export const MAX_MESSAGE_LENGTH = 300;
export const MAX_NAME_LENGTH = 100;

export const REQUEST_STATUSES = ["pending", "denied"];

// Approved requests are deleted rather than kept as "approved": the viewer
// record itself becomes the source of truth at that point, and keeping a
// second one invites the two disagreeing.
function normalizeRequest(email, raw) {
  return {
    email,
    name: raw?.name || null,
    message: raw?.message || null,
    requestedAt: raw?.requestedAt || null,
    status: REQUEST_STATUSES.includes(raw?.status) ? raw.status : "pending",
    decidedAt: raw?.decidedAt || null,
    decidedBy: raw?.decidedBy || null,
  };
}

function clamp(value, max) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

export async function getAccessRequest(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const raw = await redis().hget(k("requests"), normalized);
  return raw ? normalizeRequest(normalized, raw) : null;
}

export async function listAccessRequests() {
  const raw = (await redis().hgetall(k("requests"))) || {};
  return Object.entries(raw)
    .map(([email, value]) => normalizeRequest(normalizeEmail(email), value))
    .sort((a, b) => {
      // Pending first, then newest — an admin cares about the queue, not the
      // archive of things they already turned down.
      if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
      return new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0);
    });
}

export async function countPendingRequests() {
  const all = await listAccessRequests();
  return all.filter((r) => r.status === "pending").length;
}

// Records a new request. Returns null if one already exists — re-requesting
// neither creates a duplicate nor silently resets a previous denial.
export async function createAccessRequest(email, { name, message } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const existing = await getAccessRequest(normalized);
  if (existing) return null;
  const record = {
    name: clamp(name, MAX_NAME_LENGTH),
    message: clamp(message, MAX_MESSAGE_LENGTH),
    requestedAt: new Date().toISOString(),
    status: "pending",
    decidedAt: null,
    decidedBy: null,
  };
  await redis().hset(k("requests"), { [normalized]: record });
  return normalizeRequest(normalized, record);
}

// Marks a request denied, keeping the record so the person doesn't
// immediately re-appear in the queue and the admin can see what they already
// decided. Deleting the record is what re-opens the door.
export async function denyAccessRequest(email, actor) {
  const normalized = normalizeEmail(email);
  const existing = await getAccessRequest(normalized);
  if (!existing) return null;
  const record = {
    ...existing,
    status: "denied",
    decidedAt: new Date().toISOString(),
    decidedBy: actor || null,
  };
  await redis().hset(k("requests"), { [normalized]: record });
  return normalizeRequest(normalized, record);
}

export async function deleteAccessRequest(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return Boolean(await redis().hdel(k("requests"), normalized));
}
