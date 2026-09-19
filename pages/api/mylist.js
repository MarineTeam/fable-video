// The viewer's own saved queue.
//
//   GET     -> { videos: [...] }  saved videos, newest saved first
//   POST    -> { videoId }        save one
//   DELETE  -> ?videoId=...       unsave one
//
// Per-viewer data, so the guard is requireAccess and the email comes from the
// SESSION, never from the request. There is deliberately no way to read or
// write another person's list: this route takes no email parameter at all,
// which is a stronger guarantee than checking one.
//
// RATE-LIMITED, unlike most cheap Redis writes here, because this is a
// *viewer* write path rather than an admin one. It is the same shape as the
// gap the sibling repo's backlog names as its only unlimited write: cheap per
// call, unbounded in aggregate, and reachable by anyone with an approved
// account. The budget is loose enough that real clicking never meets it.
import { requireAccess } from "../../lib/guard";
import { oneTrimmed } from "../../lib/params";
import { allowRequest } from "../../lib/ratelimit";
import { scopeAllows } from "../../lib/roles";
import { getMyList, removeFromMyList, saveToMyList } from "../../lib/store";
import { isFull, MAX_ITEMS, savedVideos } from "../../lib/mylist";
import { fetchVideoLibrary } from "../../lib/videoList";
import { withMonitorApi } from "../../lib/monitor";

async function handler(req, res) {
  const access = await requireAccess(req, res);
  if (!access) return;

  if (req.method === "GET") {
    try {
      const [raw, library] = await Promise.all([
        getMyList(access.email),
        // The SAME library call the homepage uses, so the saved row inherits
        // its group-scope, schedule and readiness filtering. A saved id whose
        // video is now out of scope or outside its publish window simply is
        // not in `library`, so savedVideos drops it — saving something can
        // never outlive the right to see it.
        fetchVideoLibrary(access.videoScope),
      ]);
      return res.json({ videos: savedVideos(library.videos, raw), max: MAX_ITEMS });
    } catch (err) {
      console.error("Could not load the saved list:", err);
      return res.status(502).json({ error: "Could not load your list" });
    }
  }

  if (req.method === "POST" || req.method === "DELETE") {
    if (!(await allowRequest("mylist", access.email, 120, "1 h"))) {
      return res.status(429).json({ error: "Too many changes — try again shortly" });
    }

    const videoId =
      req.method === "POST" ? oneTrimmed(req.body?.videoId) : oneTrimmed(req.query.videoId);
    if (!videoId) return res.status(400).json({ error: "Video id is required" });

    // Saving is not a way around group scope. Without this, a restricted
    // viewer could pin an id they cannot see; it would be filtered out of
    // every read, but the write itself would have succeeded and told them
    // the id exists. 404 rather than 403, matching the watch page.
    if (!scopeAllows(access.videoScope, videoId)) {
      return res.status(404).json({ error: "Not found" });
    }

    try {
      if (req.method === "DELETE") {
        await removeFromMyList(access.email, videoId);
        return res.json({ ok: true, saved: false });
      }

      const raw = await getMyList(access.email);
      // Checked before the write so a full list is a clear refusal rather
      // than a silent drop. Re-saving something already present is free.
      if (isFull(raw, videoId)) {
        return res.status(409).json({
          error: `Your list is full (${MAX_ITEMS}). Remove something first.`,
        });
      }
      await saveToMyList(access.email, videoId);
      return res.json({ ok: true, saved: true });
    } catch (err) {
      console.error("Could not change the saved list:", err);
      return res.status(502).json({ error: "Could not change your list" });
    }
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
