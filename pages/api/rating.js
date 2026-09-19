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
import {
  applyRatingCounts,
  clearRating,
  getRatings,
  setRating,
} from "../../lib/store";
import { countField, normalizeVote, ratingOf, voteDelta } from "../../lib/ratings";
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
      const previous = ratingOf(await getRatings(access.email), videoId);
      // Re-sending the same vote is a no-op rather than a second increment.
      if (previous === next) return res.json({ ok: true, vote: next });

      if (next) await setRating(access.email, videoId, next);
      else await clearRating(access.email, videoId);

      // AFTER the authoritative write, and outside its error path: the vote
      // has already succeeded, so a counter failure must not report it as a
      // failure. It would be the worst answer available — the viewer would
      // see their click revert while the vote stood, and a retry would be a
      // no-op that answers "ok". lib/store.js swallows per-field errors too;
      // this catch is the one that matters, because it is the one that
      // decides what the viewer is told.
      const delta = voteDelta(previous, next);
      const fields = {};
      for (const [vote, amount] of Object.entries(delta)) {
        if (!amount) continue;
        const field = countField(videoId, vote);
        if (field) fields[field] = amount;
      }
      await applyRatingCounts(fields).catch((err) => {
        console.error("Could not update the rating counters:", err);
      });

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
