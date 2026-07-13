// Shared helpers for the diagnostics-and-tooling scripts. Not a standalone
// entry point — imported by check-env.mjs, check-redis.mjs, check-bunny.mjs,
// and sign-embed.mjs. Keeping this logic in one place means all four scripts
// resolve env vars identically instead of drifting.
//
// SAFETY: nothing in this file prints secret values. mask() only ever
// returns a short prefix plus a length count.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root = two directories up from scripts/ (scripts -> diagnostics-and-tooling
// -> skills -> .claude -> repo root is one more level up). Computed from this
// file's own location so scripts work regardless of the caller's cwd.
export function repoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "..");
}

// Minimal .env.local parser (dotenv is not a dependency of this repo, per
// package.json, so this replicates just the subset Next.js relies on:
// KEY=VALUE lines, optional quotes, #-comments, blank lines skipped).
// Values already present in process.env are NOT overridden, matching
// Next.js/dotenv precedence (real environment wins over the file).
export function loadDotEnvLocal(root = repoRoot()) {
  const envPath = path.join(root, ".env.local");
  const result = { path: envPath, found: false, loadedKeys: [] };
  if (!fs.existsSync(envPath)) return result;
  result.found = true;
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
    if (!(key in process.env)) {
      process.env[key] = value;
      result.loadedKeys.push(key);
    }
  }
  return result;
}

// Replicates lib/redis.js's envBySuffix EXACTLY (see lib/redis.js:12-17):
// Vercel prefixes storage-integration env vars with the store's name when a
// project has more than one connected (e.g. "fablevideo_KV_REST_API_URL"
// instead of plain "KV_REST_API_URL"), so match by suffix rather than an
// exact key.
export function envBySuffix(name) {
  if (process.env[name]) return { value: process.env[name], sourceKey: name, matchedBySuffix: false };
  const key = Object.keys(process.env).find((k2) => k2.endsWith(`_${name}`));
  return key ? { value: process.env[key], sourceKey: key, matchedBySuffix: true } : null;
}

// Safe-to-print summary of a secret: first 3 chars + asterisks for the rest,
// plus the real length. Never returns the full value.
export function mask(value) {
  if (value === undefined || value === null || value === "") return "(empty)";
  const str = String(value);
  const prefix = str.slice(0, 3);
  const stars = "*".repeat(Math.max(0, str.length - 3));
  return `${prefix}${stars} (len=${str.length})`;
}

// Read-only enforcement, in code rather than in a comment: wraps an
// @upstash/redis client in a Proxy that only allows an explicit allowlist of
// non-mutating commands. Any other method call (set, del, hset, flushall,
// expire, ...) throws before it ever reaches the network. check-redis.mjs
// calls every Redis command through this wrapper.
const READ_ONLY_COMMANDS = new Set(["ping", "scan", "hgetall", "get", "ttl", "type", "dbsize"]);

export function readOnlyRedis(client) {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (!READ_ONLY_COMMANDS.has(String(prop))) {
        return () => {
          throw new Error(
            `refusing to call redis().${String(prop)}() — not in the read-only allowlist ` +
              `(${[...READ_ONLY_COMMANDS].join(", ")}). This script is read-only by design.`
          );
        };
      }
      return value.bind(target);
    },
  });
}

export function printHeader(title) {
  console.log(title);
  console.log("=".repeat(title.length));
}
