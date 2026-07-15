#!/usr/bin/env node
// check-env.mjs — inventory and health-check every environment variable the
// Marine Video Portal reads (per README.md "Environment variables" and
// .claude/skills/environment-and-config/references/env.local.template).
//
// USAGE
//   node .claude/skills/diagnostics-and-tooling/scripts/check-env.mjs
//   (run from anywhere — repo root is resolved from this file's own path)
//
// WHAT IT DOES
//   1. Loads .env.local if present (repo root), without overriding any var
//      already set in the real environment.
//   2. Resolves every var the app reads, using the SAME suffix-matching
//      logic as lib/redis.js for the Redis pair (Vercel prefixes storage
//      vars with the store name when >1 store is connected).
//   3. Prints a table: NAME | status | masked value | source.
//   4. Prints degraded-mode warnings for optional vars that are missing.
//   5. Exits 0 if every REQUIRED var resolved, 1 otherwise.
//
// SAFETY
//   Read-only: only reads process.env and .env.local off disk. Never prints
//   a full secret value — only a 3-char prefix + length (see mask() in
//   _lib.mjs). Makes no network calls.
//
// EXPECTED OUTPUT (unconfigured — nothing set, no .env.local): every
// required var reports "MISSING", summary reports 11/11 required missing,
// exit code 1. See SKILL.md for the actual captured run.
//
// EXPECTED OUTPUT (fully configured): every required var reports "set" or
// "set (suffix)" with a masked value, 0 degraded-mode warnings unless an
// optional var (e.g. BUNNY_CDN_HOSTNAME) is intentionally omitted, exit 0.

import { loadDotEnvLocal, envBySuffix, mask, repoRoot, printHeader } from "./_lib.mjs";

const dotenv = loadDotEnvLocal();

// Plain vars: resolved by exact process.env name only.
const REQUIRED_PLAIN = [
  ["AUTH0_SECRET", "session cookie encryption key"],
  ["AUTH0_DOMAIN", "Auth0 tenant domain (no scheme)"],
  ["AUTH0_CLIENT_ID", "Auth0 application client id"],
  ["AUTH0_CLIENT_SECRET", "Auth0 application client secret"],
  ["APP_BASE_URL", "exact site URL, no trailing slash"],
  ["ADMIN_EMAILS", "comma-separated admin allowlist"],
  ["BUNNY_LIBRARY_ID", "bunny.net Stream library id"],
  ["BUNNY_API_KEY", "bunny.net Stream library API key"],
  ["BUNNY_TOKEN_AUTH_KEY", "bunny.net embed view token auth key"],
];

const OPTIONAL_PLAIN = [
  ["BUNNY_CDN_HOSTNAME", "pull-zone host", "thumbnails disabled -> homepage falls back to a title list"],
  ["BUNNY_CDN_TOKEN_KEY", "pull zone URL token key", "falls back to BUNNY_TOKEN_AUTH_KEY (silent, not degraded)"],
  ["RESEND_API_KEY", "Resend API key", "share emails disabled -> admins must copy links manually"],
  ["EMAIL_FROM", "Resend sender address", "share emails disabled -> admins must copy links manually"],
  ["EMAIL_REPLY_TO", "optional reply-to", "cosmetic only, no degraded mode"],
  ["SITE_NAME", "portal name used in emails", 'defaults to "Marine Video Portal"'],
  ["NEXT_PUBLIC_SITE_NAME", "portal name in header/title (client-bundled)", 'defaults to "Marine Video Portal"'],
  ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "Web Push public key (client-bundled)", "Web Push disabled -> Notify me button hidden, no notifications"],
  ["VAPID_PRIVATE_KEY", "Web Push private key (secret)", "Web Push disabled -> subscribe/notify endpoints 503, no notifications sent"],
  ["VAPID_SUBJECT", "Web Push VAPID contact (mailto:/https:)", "falls back to APP_BASE_URL (silent, not degraded)"],
  ["SENTRY_DSN", "server-side error capture", "inert, no error capture server-side"],
  ["NEXT_PUBLIC_SENTRY_DSN", "client-side error capture (client-bundled)", "inert, no error capture client-side"],
  ["SENTRY_ORG", "build-time source-map upload", "source maps not uploaded to Sentry at build"],
  ["SENTRY_PROJECT", "build-time source-map upload", "source maps not uploaded to Sentry at build"],
  ["SENTRY_AUTH_TOKEN", "build-time source-map upload (secret)", "source maps not uploaded to Sentry at build"],
];

function resolvePlain(name) {
  const value = process.env[name];
  if (value === undefined || value === "") return { status: "MISSING", value: null, source: null };
  return { status: "set", value, source: name };
}

function resolveSuffix(name) {
  const found = envBySuffix(name);
  if (!found) return { status: "MISSING", value: null, source: null };
  return {
    status: found.matchedBySuffix ? "set (suffix)" : "set",
    value: found.value,
    source: found.sourceKey,
  };
}

const rows = [];
let requiredMissing = 0;

printHeader("check-env — Marine Video Portal environment inventory");
console.log(`repo root: ${repoRoot()}`);
console.log(
  dotenv.found
    ? `.env.local: found, loaded ${dotenv.loadedKeys.length} new key(s) (existing process.env values were not overridden)`
    : ".env.local: not found (fine if running in a shell that already exports the vars, e.g. Vercel/CI)"
);
console.log("");

for (const [name, note] of REQUIRED_PLAIN) {
  const r = resolvePlain(name);
  if (r.status === "MISSING") requiredMissing++;
  rows.push([name, r.status, r.value ? mask(r.value) : "-", note]);
}

// Redis: URL + TOKEN, each resolved via exact-or-suffix, matching
// lib/redis.js's own precedence — KV_REST_API_* first, then UPSTASH_*.
const redisUrl =
  resolveSuffix("KV_REST_API_URL").status !== "MISSING"
    ? resolveSuffix("KV_REST_API_URL")
    : resolveSuffix("UPSTASH_REDIS_REST_URL");
const redisToken =
  resolveSuffix("KV_REST_API_TOKEN").status !== "MISSING"
    ? resolveSuffix("KV_REST_API_TOKEN")
    : resolveSuffix("UPSTASH_REDIS_REST_TOKEN");

if (redisUrl.status === "MISSING") requiredMissing++;
if (redisToken.status === "MISSING") requiredMissing++;
rows.push([
  "KV_REST_API_URL | UPSTASH_REDIS_REST_URL",
  redisUrl.status,
  redisUrl.value ? mask(redisUrl.value) : "-",
  redisUrl.source ? `via ${redisUrl.source}` : "Redis connection URL",
]);
rows.push([
  "KV_REST_API_TOKEN | UPSTASH_REDIS_REST_TOKEN",
  redisToken.status,
  redisToken.value ? mask(redisToken.value) : "-",
  redisToken.source ? `via ${redisToken.source}` : "Redis connection token",
]);

console.log("-- Required --");
for (const [name, status, masked, note] of rows) {
  console.log(`${status === "MISSING" ? "[MISSING]" : "[OK]     "} ${name.padEnd(40)} ${masked.padEnd(20)} ${note}`);
}

console.log("");
console.log("-- Optional (degraded mode if missing) --");
const optionalRows = [];
for (const [name, note, degraded] of OPTIONAL_PLAIN) {
  const r = resolvePlain(name);
  optionalRows.push([name, r.status, r.value ? mask(r.value) : "-", note, degraded]);
}
for (const [name, status, masked, note] of optionalRows) {
  console.log(`${status === "MISSING" ? "[unset]  " : "[OK]     "} ${name.padEnd(28)} ${masked.padEnd(20)} ${note}`);
}

console.log("");
console.log("-- Degraded-mode warnings --");
let warnings = 0;
for (const [name, , degraded] of OPTIONAL_PLAIN) {
  const r = resolvePlain(name);
  if (r.status === "MISSING" && !degraded.startsWith("falls back") && !degraded.startsWith("cosmetic")) {
    console.log(`  - ${name} missing -> ${degraded}`);
    warnings++;
  }
}
if (warnings === 0) console.log("  (none)");

console.log("");
console.log("-- Summary --");
console.log(`Required vars missing: ${requiredMissing} / ${REQUIRED_PLAIN.length + 2}`);
console.log(`Optional degraded-mode warnings: ${warnings}`);

if (requiredMissing > 0) {
  console.log("");
  console.log("RESULT: NOT READY — one or more required env vars are missing. See [MISSING] rows above.");
  process.exit(1);
} else {
  console.log("");
  console.log("RESULT: all required env vars resolved.");
  process.exit(0);
}
