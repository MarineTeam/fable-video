// Sliding-window rate limiting on sensitive endpoints. Fails open: an
// infrastructure hiccup must never lock real users out.
import { Ratelimit } from "@upstash/ratelimit";
import { k, redis } from "./redis";

const limiters = new Map();

function limiterFor(name, tokens, window) {
  const cacheKey = `${name}:${tokens}:${window}`;
  if (!limiters.has(cacheKey)) {
    limiters.set(
      cacheKey,
      new Ratelimit({
        redis: redis(),
        limiter: Ratelimit.slidingWindow(tokens, window),
        prefix: k("rl", name),
      })
    );
  }
  return limiters.get(cacheKey);
}

export async function allowRequest(name, id, tokens, window) {
  try {
    const { success } = await limiterFor(name, tokens, window).limit(id);
    return success;
  } catch {
    return true;
  }
}
