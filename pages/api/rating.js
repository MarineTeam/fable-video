// The viewer's own rating of one video.
//
//   GET    ?videoId=...          -> { vote: "up" | "down" | null }
//   POST   { videoId, vote }     -> set it ("up" or "down")
//   DELETE ?videoId=...          -> clear it
//
// Per-viewer data, so the guard is requireAccess and the email comes from the
// SESSION. Like /api/mylist, this route takes no email parameter at all, which
// is a stronger guarantee than validating one: there is no input that could
// name another person.
//
// RATING IS GATED LIKE WATCHING, through the same scopeAllows check the watch
// page performs. Without it a restricted viewer could rate a video they cannot
// see — the vote would be invisible to them afterwards, but the write would
// have succeeded, and a 200 is itself an answer to "does this id exist?".
//
// TOTALS ARE NEVER RETURNED HERE. A viewer sees their own vote and nothing
// else; the counts are staff-only and served from the admin list. See
// lib/ratings.js for why.
import { requireAccess } from "../../lib/guard";
import { oneTrimmed } from "../../lib/params";
import { allowRequest } from "../../lib/ratelimit";
import { scopeAllows } from "../../lib/roles";
import { getRatings, recordRating } from "../../lib/store";
import { normalizeVote, ratingOf } from "../../lib/ratings";
import { withMonitorApi } from "../../lib/monitor";

async function handler(req, res) {
  const access = await requireAccess(req, res);
  if (!access) return;

  const videoId =
    req.method === "POST" ? oneTrimmed(req.body?.videoId) : oneTrimmed(req.query.videoId);
  if (!videoId) return res.status(400).json({ error: "Video id is required" });

  if (req.method === "GET") {
    try {
      return res.json({ vote: ratingOf(await getRatings(access.email), videoId) });
    } catch (err) {
      console.error("Could not read a rating:", err);
      return res.status(502).json({ error: "Could not read your rating" });
    }
  }

  if (req.method === "POST" || req.method === "DELETE") {
    // A viewer write path, same shape as /api/mylist: cheap per call,
    // unbounded in aggregate, reachable by anyone approved.
    if (!(await allowRequest("rating", access.email, 120, "1 h"))) {
      return res.status(429).json({ error: "Too many ratings — try again shortly" });
    }

    if (!scopeAllows(access.videoScope, videoId)) {
      return res.status(404).json({ error: "Not found" });
    }

    // Strict: "up", "down", or nothing. A DELETE clears, so there is no third
    // spelling of "no opinion" to get wrong.
    const next = req.method === "DELETE" ? null : normalizeVote(req.body?.vote);
    if (req.method === "POST" && !next) {
      return res.status(400).json({ error: "Rating must be up or down" });
    }

    try {
      // One Redis script writes the vote and moves both counters, reading the
      // previous vote inside itself — so a repeated vote is a no-op, two racing
      // clicks cannot both count, and there is no second write left to fail
      // after the first succeeded. A failure here almost always means nothing
      // was written, so it is reported as a failed save. The exception is a
      // reply lost AFTER Redis ran the script: the vote stands, the button
      // reverts, and the viewer's next click lands on the stored state.
      await recordRating(access.email, videoId, next);
      return res.json({ ok: true, vote: next });
    } catch (err) {
      console.error("Could not save a rating:", err);
      return res.status(502).json({ error: "Could not save your rating" });
    }
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
