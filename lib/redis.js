import { Redis } from "@upstash/redis";

const PREFIX = "fablevideo";

// Key helper: k("share", id) -> "fablevideo:share:<id>". Every key the app
// touches is namespaced under the fablevideo: prefix.
export function k(...parts) {
  return [PREFIX, ...parts].join(":");
}

// Vercel prefixes storage-integration env vars with the store's name when a
// project has more than one connected (e.g. "fablevideo_KV_REST_API_URL"
// instead of plain "KV_REST_API_URL"), so match by suffix rather than an
// exact key.
function envBySuffix(name) {
  if (process.env[name]) return process.env[name];
  const key = Object.keys(process.env).find((k2) => k2.endsWith(`_${name}`));
  return key ? process.env[key] : undefined;
}

let client;

export function redis() {
  if (!client) {
    client = new Redis({
      url: envBySuffix("KV_REST_API_URL") || envBySuffix("UPSTASH_REDIS_REST_URL"),
      token: envBySuffix("KV_REST_API_TOKEN") || envBySuffix("UPSTASH_REDIS_REST_TOKEN"),
    });
  }
  return client;
}
