// Append-only admin action log, capped. Logging is best-effort so it never
// breaks the underlying action.
import { k, redis } from "./redis";

const MAX_ENTRIES = 200;

export async function logAction(actor, action, detail = "") {
  try {
    const r = redis();
    await r.lpush(
      k("audit"),
      JSON.stringify({ actor, action, detail, at: new Date().toISOString() })
    );
    await r.ltrim(k("audit"), 0, MAX_ENTRIES - 1);
  } catch {
    // Best-effort by design.
  }
}

export async function recentActions(limit = 100) {
  const raw = await redis().lrange(k("audit"), 0, limit - 1);
  return (raw || [])
    .map((item) => {
      if (typeof item === "string") {
        try {
          return JSON.parse(item);
        } catch {
          return null;
        }
      }
      return item;
    })
    .filter(Boolean);
}
