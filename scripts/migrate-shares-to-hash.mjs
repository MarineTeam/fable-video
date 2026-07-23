#!/usr/bin/env node
// migrate-shares-to-hash.mjs — one-time carry-forward of share links from
// the pre-v1.13 storage shape (one Redis STRING key per share, plus a SET
// index for listing) into the v1.13+ shape (a single HASH, field = share
// id — see lib/shares.js's header comment for why: Upstash bills a
// multi-key command like the old MGET per key, but a single-hash command
// like HGETALL/HMGET/HSETEX/HDEL is billed once regardless of field count,
// so listing/bulk-acting on shares got dramatically cheaper once every
// share lives in one hash instead of N standalone keys).
//
// WHY THIS SCRIPT MUST BE RUN (read this before skipping it)
//   lib/shares.js only reads/writes fablevideo:shares (the hash) as of this
//   change. Any share created before this deploy lives under the OLD keys
//   (fablevideo:share:<id> + fablevideo:shares:index) and is invisible to
//   the app until copied forward — those links would silently stop
//   resolving (a real, user-facing regression for anyone holding a
//   currently-valid emailed share link). This repo has a documented
//   precedent for exactly this mistake: FA-5 in the failure-archaeology
//   skill, a 2026-07-09 key-prefix rename that shipped with no migration
//   and orphaned all pre-existing data. Do not repeat that — run this
//   script once, around deploy time, before treating the migration as done.
//
// USAGE
//   node scripts/migrate-shares-to-hash.mjs            # dry run (default) — reports only, writes nothing
//   node scripts/migrate-shares-to-hash.mjs --apply     # actually copies the data forward
//
// WHAT IT DOES
//   1. Loads .env.local (if present, without overriding real env vars) and
//      resolves KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN via
//      the same suffix-matching lib/redis.js uses.
//   2. Imports { redis, k } from the repo's own lib/redis.js for fidelity.
//   3. Reads the OLD index (SMEMBERS fablevideo:shares:index) and, for each
//      id, the old record (GET fablevideo:share:<id>) and its remaining
//      physical TTL (TTL fablevideo:share:<id>).
//   4. For every id with a live record (TTL > 0), writes it into the new
//      hash with HSETEX ... EX <that same remaining ttl> — carrying the
//      exact remaining grace window forward, not resetting it.
//   5. NEVER deletes, SREMs, or otherwise touches the old keys — they are
//      left in place, inert, exactly like the pvp:* keys from FA-5. This
//      script is safe to re-run (idempotent: re-migrating an id just
//      re-writes the same data with a freshly-read remaining TTL).
//   6. Prints a summary: legacy ids found, migrated, skipped (missing or
//      already past their grace window), and any per-id errors.
//
// SAFETY
//   Dry run by default. The only mutating call this script ever makes is
//   HSETEX on the NEW hash key (fablevideo:shares) — it never writes to,
//   or deletes, anything under the old fablevideo:share:*/fablevideo:shares:index
//   keys.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function repoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function loadDotEnvLocal(root = repoRoot()) {
  const envPath = path.join(root, ".env.local");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function envBySuffix(name) {
  if (process.env[name]) return process.env[name];
  const key = Object.keys(process.env).find((k2) => k2.endsWith(`_${name}`));
  return key ? process.env[key] : undefined;
}

const APPLY = process.argv.includes("--apply");

loadDotEnvLocal();

console.log("migrate-shares-to-hash — carry forward pre-v1.13 share links");
console.log("===============================================================");
console.log(`repo root: ${repoRoot()}`);
console.log(`mode: ${APPLY ? "APPLY (writing to Redis)" : "DRY RUN (no writes — pass --apply to write)"}`);
console.log("");

const url = envBySuffix("KV_REST_API_URL") || envBySuffix("UPSTASH_REDIS_REST_URL");
const token = envBySuffix("KV_REST_API_TOKEN") || envBySuffix("UPSTASH_REDIS_REST_TOKEN");

if (!url || !token) {
  console.log("STATUS: not configured — cannot connect.");
  console.log(`  KV_REST_API_URL / UPSTASH_REDIS_REST_URL:     ${url ? "set" : "MISSING"}`);
  console.log(`  KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN: ${token ? "set" : "MISSING"}`);
  console.log("");
  console.log("Set these in .env.local (see .claude/skills/environment-and-config) and re-run.");
  process.exit(1);
}

let redisModule;
try {
  redisModule = await import(new URL("../lib/redis.js", import.meta.url));
} catch (err) {
  console.log(`STATUS: failed to load lib/redis.js — ${err.message}`);
  process.exit(1);
}
const { redis: getClient, k } = redisModule;
const r = getClient();

try {
  await r.ping();
} catch (err) {
  console.log(`STATUS: connection/auth failed — ${err.message}`);
  process.exit(1);
}

const oldIndexKey = k("shares", "index");
const oldShareKey = (id) => k("share", id);
const newHashKey = k("shares");

const ids = (await r.smembers(oldIndexKey)) || [];
console.log(`Legacy index (${oldIndexKey}): ${ids.length} id(s) found.`);
console.log("");

if (!ids.length) {
  console.log("Nothing to migrate. RESULT: complete (no-op).");
  process.exit(0);
}

let migrated = 0;
let skippedMissing = 0;
let skippedExpired = 0;
let errors = 0;

for (const id of ids) {
  try {
    const [record, ttl] = await Promise.all([r.get(oldShareKey(id)), r.ttl(oldShareKey(id))]);
    if (!record) {
      skippedMissing += 1;
      continue;
    }
    if (!Number.isFinite(ttl) || ttl <= 0) {
      // No physical TTL left (or the key has no expiry at all) — already
      // past its grace window from the old key's perspective; nothing
      // meaningful to carry forward.
      skippedExpired += 1;
      continue;
    }
    if (APPLY) {
      await r.hsetex(newHashKey, { expiration: { ex: ttl } }, { [id]: record });
    }
    migrated += 1;
  } catch (err) {
    errors += 1;
    console.error(`  error migrating id ${id}: ${err.message}`);
  }
}

console.log(`${APPLY ? "Migrated" : "Would migrate"}: ${migrated}`);
console.log(`Skipped (no record found):        ${skippedMissing}`);
console.log(`Skipped (no remaining TTL):        ${skippedExpired}`);
console.log(`Errors:                            ${errors}`);
console.log("");
console.log(
  `Old keys (${oldIndexKey} and each ${k("share", "<id>")}) were NOT modified or deleted — ` +
    "safe to leave in place, and safe to re-run this script."
);

if (!APPLY && migrated > 0) {
  console.log("");
  console.log(`This was a dry run. Re-run with --apply to actually write ${migrated} record(s).`);
}

console.log("");
console.log(`RESULT: ${errors > 0 ? "completed with errors" : "complete"}.`);
process.exit(errors > 0 ? 1 : 0);
