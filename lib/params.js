// Strict readers for untrusted request parameters.
//
// Exists because of a CodeQL "type confusion through parameter tampering"
// finding (Critical) on `Number(req.body?.length)` in
// pages/api/admin/videos.js. Two distinct hazards, both real:
//
//  1. **A parameter can arrive as an array.** Next.js hands `req.query.x` back
//     as `string | string[]` when a key repeats (`?x=a&x=b`), and a JSON body
//     can carry an array for any field. `String(["a","b"])` quietly becomes
//     `"a,b"` — a value that was never sent, silently accepted.
//  2. **`.length` is a built-in.** If `req.body` is itself an array or a
//     string rather than an object, `req.body.length` returns ITS size, not a
//     user field at all. That is the specific confusion CodeQL flagged, and it
//     is why the offending field was also renamed away from `length`.
//
// The rule these helpers encode: coercion is not validation. A value of the
// wrong TYPE is rejected, never bent into the right shape. Callers get a
// predictable `null`/`fallback` and decide what to do about it.

// One string, or null. An array, number, object, boolean, or missing value is
// rejected outright rather than stringified.
export function oneString(value) {
  return typeof value === "string" ? value : null;
}

// One trimmed, non-empty string, or null.
export function oneTrimmed(value) {
  const text = oneString(value);
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed || null;
}

// One finite number, or the fallback. Accepts a numeric string, because JSON
// bodies and query strings both legitimately carry numbers as text — but NOT
// an array, a boolean, or anything else that Number() would coerce into a
// plausible-looking value (`Number([5])` is 5; `Number(true)` is 1).
export function oneNumber(value, fallback = 0) {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

// Strict true. Used where a parameter switches on something consequential and
// "truthy" is not good enough — see pages/api/admin/public-videos.js, where
// the value decides whether a video is readable by the whole internet.
export function isExplicitlyTrue(value) {
  return value === true;
}
