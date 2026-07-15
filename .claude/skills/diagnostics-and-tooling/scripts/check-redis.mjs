#!/usr/bin/env node
// check-redis.mjs — connect to the portal's Upstash Redis exactly the way
// lib/redis.js does, PING it, then SCAN (cursor loop, COUNT 100) to census
// keys by family under fablevideo:* and detect orphaned pvp:* keys left
// over from the 2026-07-09 prefix rename (commit c37919e) that was never
// migrated.
//
// USAGE
//   node .claude/skills/diagnostics-and-tooling/scripts/check-redis.mjs
//
// WHAT IT DOES
//   1. Loads .env.local (if present) and resolves KV_REST_API_URL/TOKEN or
//      UPSTASH_REDIS_REST_URL/TOKEN via the same suffix-matching lib/redis.js
//      uses.
//   2. Imports { redis, k } from the repo's own lib/redis.js for fidelity
//      (same client construction the app uses at runtime).
//   3. Wraps the client in a read-only Proxy (see _lib.mjs) that allows only
//      ping/scan/hgetall/get/ttl/type/dbsize — any mutating call throws
//      before hitting the network.
//   4. PINGs, then SCANs the whole keyspace once, bucketing every key by its
//      "fablevideo:<family>" second segment, and separately counting pvp:*
//      keys.
//   5. Prints counts only — never key names or values. Some fablevideo:
//      families (progress, rl) embed viewer emails IN THE KEY NAME itself
//      (see lib/store.js k("progress", email), lib/ratelimit.js prefix +
//      id), so even printing raw key names would leak PII; this script
//      only ever prints the family name and a running count.
//
// SAFETY
//   Read-only. SCAN only (never KEYS, which can block a large production
//   instance). No FLUSH/DEL/EXPIRE/SET — enforced in code via the
//   readOnlyRedis() proxy in _lib.mjs, not just by convention.
//
// EXPECTED OUTPUT (unconfigured — no Redis env vars): reports which of
// KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN are missing and
// exits 1 without attempting a connection. See SKILL.md for the actual run.
//
// EXPECTED OUTPUT (with credentials): PING -> PONG, then a per-family count
// table, e.g.:
//   fablevideo:settings     1
//   fablevideo:viewers      1   (one hash, N fields — see note)
//   fablevideo:lastseen     1   (one hash, N fields)
//   fablevideo:order        1
//   fablevideo:theme        1
//   fablevideo:progress     <N individual keys, one per viewer email>
//   fablevideo:share        <N live shares>
//   fablevideo:shares       1   (the index set)
//   fablevideo:audit        1   (one capped list)
//   fablevideo:rl           <N, one per rate-limited actor/window>
//   fablevideo:push         <0-3: subs hash, notified set, seeded sentinel — only if Web Push is configured>
//   pvp:* (orphaned)        <N — 0 expected, loudly flagged if > 0>
// exits 0 on success (even if pvp:* orphans are found — that's a report,
// not a failure of this script), 1 on connection/auth error.

import { loadDotEnvLocal, envBySuffix, readOnlyRedis, repoRoot, printHeader } from "./_lib.mjs";

loadDotEnvLocal();

printHeader("check-redis — Marine Video Portal Redis census");
console.log(`repo root: ${repoRoot()}`);
console.log("");

const url = envBySuffix("KV_REST_API_URL") || envBySuffix("UPSTASH_REDIS_REST_URL");
const token = envBySuffix("KV_REST_API_TOKEN") || envBySuffix("UPSTASH_REDIS_REST_TOKEN");

if (!url || !token) {
  console.log("STATUS: not configured — cannot connect.");
  console.log(`  KV_REST_API_URL / UPSTASH_REDIS_REST_URL:     ${url ? `set (via ${url.sourceKey})` : "MISSING"}`);
  console.log(`  KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN: ${token ? `set (via ${token.sourceKey})` : "MISSING"}`);
  console.log("");
  console.log("Set these in .env.local (see .claude/skills/environment-and-config) and re-run.");
  process.exit(1);
}

let redisModule;
try {
  // Imported from the repo's own lib/redis.js for fidelity — same client
  // construction the app uses at runtime. Node 22 reparses this CommonJS-
  // looking .js file as ESM automatically (it contains `import` syntax);
  // that prints a one-line MODULE_TYPELESS_PACKAGE_JSON warning to stderr,
  // which is expected and harmless (see SKILL.md).
  redisModule = await import(new URL("../../../../lib/redis.js", import.meta.url));
} catch (err) {
  console.log(`STATUS: failed to load lib/redis.js — ${err.message}`);
  process.exit(1);
}

const { redis: getClient, k } = redisModule;
const r = readOnlyRedis(getClient());

try {
  const pong = await r.ping();
  console.log(`PING -> ${pong}`);
} catch (err) {
  console.log(`STATUS: connection/auth failed — ${err.message}`);
  console.log("Check the Redis URL/token are correct and the Upstash database is not paused/deleted.");
  process.exit(1);
}

// One SCAN pass over the whole keyspace, COUNT 100 per hop (read-only,
// cursor loop — never KEYS *, which is O(N) blocking on the server).
const familyCounts = new Map();
let pvpOrphans = 0;
let totalKeys = 0;
let cursor = "0";
const prefix = `${k()}:`; // k() with no parts returns just the PREFIX constant, "fablevideo"

do {
  const [nextCursor, keys] = await r.scan(cursor, { count: 100 });
  cursor = nextCursor;
  for (const key of keys) {
    totalKeys++;
    if (key.startsWith(prefix)) {
      const family = key.slice(prefix.length).split(":")[0];
      familyCounts.set(family, (familyCounts.get(family) || 0) + 1);
    } else if (key.startsWith("pvp:")) {
      pvpOrphans++;
    }
  }
} while (cursor !== "0");

console.log("");
console.log(`-- Key census (${totalKeys} total keys scanned) --`);
console.log(`Prefix: ${prefix}`);
const families = ["settings", "viewers", "lastseen", "order", "theme", "progress", "share", "shares", "audit", "rl", "push"];
for (const family of families) {
  console.log(`  ${prefix}${family.padEnd(10)} ${familyCounts.get(family) || 0}`);
}
const known = new Set(families);
for (const [family, count] of familyCounts) {
  if (!known.has(family)) console.log(`  ${prefix}${family} (unrecognized family)  ${count}`);
}

console.log("");
if (pvpOrphans > 0) {
  console.log(`*** WARNING: ${pvpOrphans} orphaned pvp:* key(s) found. ***`);
  console.log(
    "These predate the 2026-07-09 prefix rename (pvp: -> fablevideo:, commit c37919e) and were " +
      "never migrated. The app no longer reads them, but the data is stranded in production."
  );
  console.log("Counts only shown above — no key names or values printed (may contain viewer emails).");
} else {
  console.log("pvp:* orphans: 0 (no un-migrated pre-rename data found).");
}

console.log("");
console.log("RESULT: census complete.");
process.exit(0);
