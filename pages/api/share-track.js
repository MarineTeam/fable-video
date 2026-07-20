// Records real-playback events (play / progress / ended) reported by the
// share watch page's player.js integration, per share link — distinct from
// the page-load "view" stamp (see pages/watch/[shareId].js) and from the
// per-viewer resume progress in pages/api/progress.js. Requires login, and
// the logged-in email must match the share's recipient — same mismatch
// handling as the watch page itself: never confirm or deny anything about a
// share id that isn't the caller's.
import { requireUser } from "../../lib/guard";
import { normalizeEmail } from "../../lib/auth";
import { getShare, sharePlaybackPatch, updateShare } from "../../lib/shares";

const ALLOWED_EVENTS = new Set(["play", "progress", "ended"]);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const email = await requireUser(req, res);
  if (!email) return;

  const { shareId, event, percent } = req.body || {};
  if (!shareId || typeof shareId !== "string") {
    return res.status(400).json({ error: "shareId is required" });
  }
  if (!ALLOWED_EVENTS.has(event)) {
    return res.status(400).json({ error: "Invalid event" });
  }
  if (percent !== undefined && (typeof percent !== "number" || !Number.isFinite(percent))) {
    return res.status(400).json({ error: "Invalid percent" });
  }

  let share;
  try {
    share = await getShare(shareId);
  } catch (err) {
    console.error("Could not load share for playback tracking:", err);
    return res.status(502).json({ error: "Could not record playback" });
  }

  if (!share || normalizeEmail(share.email) !== email) {
    // Never reveal whether the share exists or belongs to someone else.
    return res.status(204).end();
  }

  try {
    await updateShare(shareId, sharePlaybackPatch(share, { event, percent }));
  } catch (err) {
    console.error("Could not record playback:", err);
  }
  return res.status(204).end();
}
