// An in-memory stand-in for lib/redis.js, for route tests that need state to
// persist across calls (a role saved, then read back by the guard). Values
// are stored as given, the way @upstash/redis hands parsed JSON back.
//
//   vi.mock("../redis", async () => (await import("./helpers/memoryRedis")).redisModule);
//   import { mem } from "./helpers/memoryRedis";
//   beforeEach(() => mem.reset());
//
// A command this file does not implement THROWS, so a test can never pass by
// a route silently getting `undefined` back from a missing method.
export const mem = {
  hashes: new Map(),
  sets: new Map(),
  lists: new Map(),
  strings: new Map(),
  failing: false,
  reset() {
    this.hashes.clear();
    this.sets.clear();
    this.lists.clear();
    this.strings.clear();
    this.failing = false;
  },
  hash(key) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    return this.hashes.get(key);
  },
  set(key) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    return this.sets.get(key);
  },
  list(key) {
    if (!this.lists.has(key)) this.lists.set(key, []);
    return this.lists.get(key);
  },
};

function guard() {
  if (mem.failing) throw new Error("redis down");
}

const commands = {
  hget: async (key, field) => (guard(), mem.hash(key).get(field) ?? null),
  hgetall: async (key) => (guard(), mem.hash(key).size ? Object.fromEntries(mem.hash(key)) : null),
  hset: async (key, obj) => {
    guard();
    for (const [f, v] of Object.entries(obj)) mem.hash(key).set(f, v);
    return Object.keys(obj).length;
  },
  hsetnx: async (key, field, value) => {
    guard();
    if (mem.hash(key).has(field)) return 0;
    mem.hash(key).set(field, value);
    return 1;
  },
  hsetex: async (key, _opts, obj) => commands.hset(key, obj),
  hdel: async (key, ...fields) => {
    guard();
    let n = 0;
    for (const f of fields) if (mem.hash(key).delete(f)) n += 1;
    return n;
  },
  hmget: async (key, ...fields) => {
    guard();
    return Object.fromEntries(fields.map((f) => [f, mem.hash(key).get(f) ?? null]));
  },
  sadd: async (key, ...members) => (guard(), members.forEach((m) => mem.set(key).add(m)), members.length),
  srem: async (key, ...members) => (guard(), members.forEach((m) => mem.set(key).delete(m)), members.length),
  smembers: async (key) => (guard(), [...mem.set(key)]),
  sismember: async (key, m) => (guard(), mem.set(key).has(m) ? 1 : 0),
  lpush: async (key, ...values) => (guard(), mem.list(key).unshift(...values), mem.list(key).length),
  ltrim: async () => (guard(), "OK"),
  lrange: async (key, start, stop) => (guard(), mem.list(key).slice(start, stop < 0 ? undefined : stop + 1)),
  get: async (key) => (guard(), mem.strings.get(key) ?? null),
  set: async (key, value) => (guard(), mem.strings.set(key, value), "OK"),
  del: async (...keys) => {
    guard();
    for (const key of keys) {
      mem.hashes.delete(key);
      mem.sets.delete(key);
      mem.lists.delete(key);
      mem.strings.delete(key);
    }
    return keys.length;
  },
};

const client = new Proxy(commands, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (prop === "then") return undefined;
    return () => {
      throw new Error(`memoryRedis: ${String(prop)} is not implemented`);
    };
  },
});

export const redisModule = {
  k: (...parts) => ["fablevideo", ...parts].join(":"),
  redis: () => client,
};
