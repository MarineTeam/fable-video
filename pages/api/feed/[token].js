// The per-subscriber podcast feed document.
//
// Unauthenticated in the session sense — podcast apps cannot log in — but not
// unauthorized: the token identifies the account, and lib/feedAccess.js
// re-resolves approval, role and group scope from Redis on every single
// fetch. See that file for why there is no revocation step.
//
// The episode list comes from fetchVideoLibrary(access.videoScope), the SAME
// function the homepage and /api/videos use. That is deliberate and worth
// preserving: group scoping, the publish/expiry window and ready-only
// filtering are applied there, once, so a feed can never show a viewer
// something the website would not.
//
// Every denial answers 404, never 403-with-detail: a feed URL is a bearer
// string that will be pasted into apps and synced between devices, and the
// response to a wrong one should not distinguish "no such token" from "that
// person is no longer approved".
import { fetchVideoLibrary } from "../../../lib/videoList";
import { resolveFeedRequest } from "../../../lib/feedAccess";
import { buildPodcastFeed } from "../../../lib/podcast";
import { mediaEnabled } from "../../../lib/bunnyMedia";
import { getSiteName } from "../../../lib/store";
import { allowRequest } from "../../../lib/ratelimit";
import { withMonitorApi } from "../../../lib/monitor";

function baseUrl() {
  return (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
}

async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = String(req.query.token || "");

  // Podcast apps poll on their own schedule and several may share one
  // account across devices; this is generous enough never to bite a real
  // subscriber and tight enough that a leaked URL can't be used to hammer
  // bunny.net. Fails open, like every other limiter here.
  if (!(await allowRequest("feed", token.slice(0, 16) || "anon", 60, "1 h"))) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const resolved = await resolveFeedRequest(token);
  if (!resolved.ok) {
    // One response for every reason. See the header comment.
    return res.status(404).json({ error: "Not found" });
  }

  let library;
  let siteName;
  try {
    [library, siteName] = await Promise.all([
      fetchVideoLibrary(resolved.access.videoScope),
      getSiteName().catch(() => null),
    ]);
  } catch (err) {
    console.error("Could not build the podcast feed:", err);
    return res.status(502).json({ error: "Could not build the feed" });
  }

  const base = baseUrl();
  // Enclosures point at THIS APP, never at bunny.net — the media route
  // re-checks entitlement and only then redirects to a short-lived signed
  // URL. See lib/bunnyMedia.js for why that indirection is the whole point.
  const episodes = library.videos.map((video) => ({
    id: video.id,
    title: video.title,
    notes: video.notes,
    length: video.length,
    publishedAt: video.dateUploaded,
    enclosureUrl: `${base}/api/feed/${encodeURIComponent(token)}/${encodeURIComponent(video.id)}.mp4`,
  }));

  const xml = buildPodcastFeed({
    siteName,
    selfUrl: `${base}/api/feed/${encodeURIComponent(token)}`,
    siteUrl: base,
    // A public, permanent asset. Deliberately NOT the signed thumbnail URL:
    // podcast apps cache artwork for a long time, and a 6-hour signed URL
    // would both break later and leave a signed bunny.net URL sitting in
    // someone's app cache.
    imageUrl: base ? `${base}/icon-512.png` : null,
    episodes: mediaEnabled() ? episodes : [],
  });

  res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
  // private: the document differs per subscriber, so no shared cache may
  // hold it. max-age is a courtesy to apps that poll aggressively.
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.statusCode = 200;
  return res.end(req.method === "HEAD" ? undefined : xml);
}

export default withMonitorApi(handler);
