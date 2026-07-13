#!/usr/bin/env node
// sign-embed.mjs — recompute a bunny.net signed embed URL EXACTLY like
// lib/bunny.js's signEmbedUrl(), for debugging playback-token mismatches
// (e.g. "the app served a token that doesn't match what I expect" —
// recompute one here with a known expiry and diff it against the app's).
//
// USAGE
//   node .claude/skills/diagnostics-and-tooling/scripts/sign-embed.mjs <videoId> [ttlSeconds]
//
//   <videoId>    required — the bunny.net video GUID.
//   [ttlSeconds] optional — defaults to 10800 (3 hours), matching
//                lib/bunny.js's own default.
//
// WHAT IT DOES
//   1. Loads .env.local (if present) and requires BUNNY_TOKEN_AUTH_KEY +
//      BUNNY_LIBRARY_ID. Refuses politely (no crash, no stack trace) if
//      either is missing.
//   2. Imports signEmbedUrl from the repo's own lib/bunny.js and calls it
//      with the given videoId/ttlSeconds — same
//      token = SHA256_hex(BUNNY_TOKEN_AUTH_KEY + videoId + expires) formula
//      the app uses at request time (lib/bunny.js signEmbedUrl, ~line 147).
//   3. Prints the full iframe URL and the expiry as both a Unix timestamp
//      and an ISO string.
//
// NOTE ON WHAT THIS PRINTS: the computed embed URL (including its token) is
// the intended output of this script — it is a short-lived, single-purpose
// derived value, not the underlying secret. BUNNY_TOKEN_AUTH_KEY itself is
// never printed; only its length is shown in the "using credentials" line.
//
// SAFETY
//   Pure computation — crypto.createHash, no network call, nothing written
//   anywhere. Never prints BUNNY_TOKEN_AUTH_KEY's value.
//
// EXPECTED OUTPUT (unconfigured — no BUNNY_TOKEN_AUTH_KEY/BUNNY_LIBRARY_ID):
// reports which var is missing and exits 1 without computing anything. See
// SKILL.md for the actual captured run.
//
// EXPECTED OUTPUT (with credentials):
//   videoId:  abc123-def456
//   ttl:      10800s (3h)
//   expires:  1799999999  (2026-07-13T18:00:00.000Z)
//   embed URL:
//     https://iframe.mediadelivery.net/embed/123456/abc123-def456?token=<64-hex-chars>&expires=1799999999&autoplay=false
// exits 0.

import { loadDotEnvLocal, mask, repoRoot, printHeader } from "./_lib.mjs";

loadDotEnvLocal();

printHeader("sign-embed — bunny.net embed token signer");
console.log(`repo root: ${repoRoot()}`);
console.log("");

const [, , videoId, ttlArg] = process.argv;

if (!videoId) {
  console.log("USAGE: node scripts/sign-embed.mjs <videoId> [ttlSeconds]");
  console.log("");
  console.log("  <videoId>    required — the bunny.net video GUID (see the id field in");
  console.log("               check-bunny.mjs output, or the /watch/<id> URL).");
  console.log("  [ttlSeconds] optional — defaults to 10800 (3h), matching lib/bunny.js.");
  process.exit(1);
}

let ttlSeconds = 3 * 3600;
if (ttlArg !== undefined) {
  const parsed = Number(ttlArg);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.log(`STATUS: invalid ttlSeconds "${ttlArg}" — must be a positive number of seconds.`);
    process.exit(1);
  }
  ttlSeconds = Math.floor(parsed);
}

const tokenAuthKey = (process.env.BUNNY_TOKEN_AUTH_KEY || "").trim();
const libraryId = (process.env.BUNNY_LIBRARY_ID || "").trim();

if (!tokenAuthKey || !libraryId) {
  console.log("STATUS: not configured — refusing to sign without both vars.");
  console.log(`  BUNNY_TOKEN_AUTH_KEY: ${tokenAuthKey ? `set (${mask(tokenAuthKey)})` : "MISSING"}`);
  console.log(`  BUNNY_LIBRARY_ID:     ${libraryId ? `set (${mask(libraryId)})` : "MISSING"}`);
  console.log("");
  console.log("Set these in .env.local (see .claude/skills/environment-and-config) and re-run.");
  process.exit(1);
}

let bunnyModule;
try {
  // Imported from the repo's own lib/bunny.js for fidelity — same formula
  // the app uses at request time. Node 22 reparses this CommonJS-looking
  // .js file as ESM automatically; the resulting MODULE_TYPELESS_PACKAGE_JSON
  // warning on stderr is expected and harmless (see SKILL.md).
  bunnyModule = await import(new URL("../../../../lib/bunny.js", import.meta.url));
} catch (err) {
  console.log(`STATUS: failed to load lib/bunny.js — ${err.message}`);
  process.exit(1);
}

const { signEmbedUrl } = bunnyModule;

console.log(`using credentials: BUNNY_TOKEN_AUTH_KEY (${mask(tokenAuthKey)}), BUNNY_LIBRARY_ID=${libraryId}`);
console.log("");

const url = signEmbedUrl(videoId, { ttlSeconds });
const expiresMatch = url.match(/[?&]expires=(\d+)/);
const expires = expiresMatch ? Number(expiresMatch[1]) : null;

console.log(`videoId:  ${videoId}`);
console.log(`ttl:      ${ttlSeconds}s (${(ttlSeconds / 3600).toFixed(2)}h)`);
if (expires) {
  console.log(`expires:  ${expires}  (${new Date(expires * 1000).toISOString()})`);
}
console.log("embed URL:");
console.log(`  ${url}`);
console.log("");
console.log(
  "Compare this against the URL the app actually served (e.g. from a browser network tab or " +
    "server log) — same videoId and a close-enough `expires` should produce an IDENTICAL token. " +
    "A mismatch means either BUNNY_TOKEN_AUTH_KEY differs between environments, or the app is " +
    "signing with a different videoId/expires than you expect."
);
process.exit(0);
