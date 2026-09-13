// A viewer's own podcast feed URL: read it, or regenerate it.
//
// Requires an approved session (requireAccess), not merely a login — there is
// no reason to hand a feed URL to someone who cannot watch anything. Note
// that this is a convenience, not the security boundary: even if a token
// escaped to an unapproved person, every fetch of it re-resolves entitlement
// and denies (see lib/feedAccess.js).
//
// The token is only ever returned to the account it belongs to. There is no
// admin endpoint that reads someone else's feed URL, deliberately — a feed
// URL is a bearer credential for that person's library view, and an admin
// already has a better way to see the library.
import { requireAccess } from "../../lib/guard";
import { ensureFeedToken, feedUrl, rotateFeedToken } from "../../lib/feedTokens";
import { getPodcastSettings } from "../../lib/store";
import { mediaEnabled } from "../../lib/bunnyMedia";
import { allowRequest } from "../../lib/ratelimit";
import { logAction } from "../../lib/audit";
import { withMonitorApi } from "../../lib/monitor";

async function handler(req, res) {
  const access = await requireAccess(req, res);
  if (!access) return;
  const email = access.email;

  let enabled = false;
  try {
    ({ enabled } = await getPodcastSettings());
  } catch (err) {
    console.error("Could not read the podcast setting:", err);
    return res.status(502).json({ error: "Could not read the podcast setting" });
  }
  // Don't mint a token for a feature that is switched off — the UI shows
  // nothing, and no unusable URL goes into circulation.
  if (!enabled) return res.json({ enabled: false, url: null, mediaReady: mediaEnabled() });

  if (req.method === "GET") {
    try {
      const token = await ensureFeedToken(email);
      return res.json({ enabled: true, url: feedUrl(token), mediaReady: mediaEnabled() });
    } catch (err) {
      console.error("Could not read the feed token:", err);
      return res.status(502).json({ error: "Could not read your feed link" });
    }
  }

  if (req.method === "POST") {
    // Regeneration is the answer to a leaked URL, so it is rate-limited but
    // never blocked: someone who thinks their link escaped should be able to
    // replace it now.
    if (!(await allowRequest("feed-rotate", email, 10, "1 h"))) {
      return res.status(429).json({ error: "Too many regenerations — try again shortly" });
    }
    try {
      const token = await rotateFeedToken(email);
      await logAction(email, "feed.rotate", email);
      return res.json({ enabled: true, url: feedUrl(token), mediaReady: mediaEnabled() });
    } catch (err) {
      console.error("Could not regenerate the feed token:", err);
      return res.status(502).json({ error: "Could not regenerate your feed link" });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
