// One podcast episode's media.
//
// This is the route that makes the feed safe. It re-runs the entire
// entitlement check — approval, role, group video scope, publish/expiry
// window — and only then hands back a short-lived signed bunny.net URL as a
// 302. Nothing is trusted from the feed document that pointed here: a
// subscriber's app may have cached that feed for days, and the answer to
// "may this person still have this video?" is re-derived now, not then.
//
// The check order matters and mirrors pages/watch/video/[id].js: identity,
// then scope, then schedule, then — last — the signed URL. No URL is minted
// for a request that is going to be refused.
import { resolveFeedRequest } from "../../../../lib/feedAccess";
import { scopeAllows } from "../../../../lib/roles";
import { getSchedule, isLive } from "../../../../lib/schedule";
import { mediaEnabled, signedMp4Url } from "../../../../lib/bunnyMedia";
import { oneString } from "../../../../lib/params";
import { allowRequest } from "../../../../lib/ratelimit";
import { withMonitorApi } from "../../../../lib/monitor";

// "<guid>.mp4" -> "<guid>". Anything else is refused rather than coerced:
// this value becomes a CDN path, so it must be exactly what we expect.
function videoIdFromFile(file) {
  // Strict string: a repeated query key arrives as an array, and joining one
  // into a path is exactly the coercion lib/params.js exists to prevent.
  const name = oneString(file) || "";
  if (!name.endsWith(".mp4")) return null;
  const id = name.slice(0, -4);
  return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null;
}

async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = oneString(req.query.token) || "";
  const videoId = videoIdFromFile(req.query.file);
  if (!videoId) return res.status(404).json({ error: "Not found" });

  if (!(await allowRequest("feed-media", token.slice(0, 16) || "anon", 120, "1 h"))) {
    return res.status(429).json({ error: "Too many requests" });
  }

  // 1. Identity, and that the feature is still on at all.
  const resolved = await resolveFeedRequest(token);
  if (!resolved.ok) return res.status(404).json({ error: "Not found" });

  // 2. Group scope. Same helper, same null-vs-empty semantics as everywhere
  // else: null is unrestricted, [] is nothing permitted.
  if (!scopeAllows(resolved.access.videoScope, videoId)) {
    return res.status(404).json({ error: "Not found" });
  }

  // 3. The publish window. Fails CLOSED here, unlike the signed-in watch
  // page: this URL is reachable with no session, so an unreadable schedule
  // must not be read as "no constraint".
  let schedule = null;
  try {
    schedule = await getSchedule(videoId);
  } catch (err) {
    console.error("Could not read the schedule for a feed episode:", err);
    return res.status(404).json({ error: "Not found" });
  }
  if (!isLive(schedule)) return res.status(404).json({ error: "Not found" });

  // 4. Only now, a signed URL — minted per request, never stored.
  if (!mediaEnabled()) return res.status(404).json({ error: "Not found" });
  const url = signedMp4Url(videoId);
  if (!url) return res.status(404).json({ error: "Not found" });

  // private + short: the Location carries a signed URL, so no shared cache
  // should keep this redirect around after the signature expires.
  res.setHeader("Cache-Control", "private, max-age=60");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Location", url);
  res.statusCode = 302;
  return res.end();
}

export default withMonitorApi(handler);
