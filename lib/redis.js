import { Redis } from "@upstash/redis";
import { monitorEnabled, recordQuery } from "./monitor";

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

// Query Monitor instrumentation: a transparent pass-through Proxy that times
// every Redis command and reports it via lib/monitor.js. Disabled (the
// default), this adds one cheap env-var check per call and nothing else —
// every existing `redis().foo(...)` call site across the app is untouched.
function instrument(rawClient) {
  return new Proxy(rawClient, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return function (...args) {
        if (!monitorEnabled()) return value.apply(target, args);
        const start = process.hrtime.bigint();
        const finish = () =>
          recordQuery(String(prop), Number(process.hrtime.bigint() - start) / 1e6);
        const result = value.apply(target, args);
        if (result && typeof result.then === "function") {
          return result.finally(finish);
        }
        finish();
        return result;
      };
    },
  });
}

let client;

export function redis() {
  if (!client) {
    const rawClient = new Redis({
      url: envBySuffix("KV_REST_API_URL") || envBySuffix("UPSTASH_REDIS_REST_URL"),
      token: envBySuffix("KV_REST_API_TOKEN") || envBySuffix("UPSTASH_REDIS_REST_TOKEN"),
    });
    client = instrument(rawClient);
  }
  return client;
}
