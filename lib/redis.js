import { Redis } from "@upstash/redis";

const PREFIX = "pvp";

// Key helper: k("share", id) -> "pvp:share:<id>". Every key the app touches
// is namespaced under the pvp: prefix.
export function k(...parts) {
  return [PREFIX, ...parts].join(":");
}

let client;

export function redis() {
  if (!client) {
    client = new Redis({
      url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return client;
}
