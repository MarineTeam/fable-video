// One video's transcript, for the watch page.
//
// GUARDED EXACTLY LIKE THE WATCH PAGE IT SERVES, and that is the whole point
// of this file. A transcript is the entire content of a private video in text
// form, so anything laxer than pages/watch/video/[id].js's own gate would be a
// way to read a video you cannot watch. The three checks below mirror that
// page line for line:
//
//   1. approved viewer            (resolveAccess)
//   2. inside your group's scope  (scopeAllows)   -> 404, never 403
//   3. inside its publish window  (isLive)        -> 404, staff exempt
//
// 404 rather than 403 on 2 and 3 for the reason that page gives: a restricted
// viewer must not be able to probe which video ids exist.
//
// The caption file itself is NEVER proxied as a URL. lib/bunny.js fetches the
// VTT server-side and this route returns parsed cues from our own origin, so
// no bunny CDN file URL reaches a browser.
import { requireAccess } from "../../../lib/guard";
import { oneTrimmed } from "../../../lib/params";
import { scopeAllows } from "../../../lib/roles";
import { getSchedule, isLive } from "../../../lib/schedule";
import { getTranscript } from "../../../lib/captionsStore";
import { withMonitorApi } from "../../../lib/monitor";

async function handler(req, res) {
  const access = await requireAccess(req, res);
  if (!access) return;

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = oneTrimmed(req.query.id);
  if (!id) return res.status(400).json({ error: "Video id is required" });

  // requireAccess already resolved this caller and refused an unapproved one,
  // so the object it returns IS the resolved access — resolving a second time
  // would be an extra Redis round trip and two answers that could disagree.
  if (!scopeAllows(access.videoScope, id)) {
    return res.status(404).json({ error: "Not found" });
  }

  if (!access.staff) {
    let schedule = null;
    try {
      schedule = await getSchedule(id);
    } catch (err) {
      // Matches the watch page and lib/videoList.js: an unreadable schedule
      // means no constraint, rather than taking live content off the air.
      console.error("Could not read the video schedule:", err);
    }
    if (!isLive(schedule)) return res.status(404).json({ error: "Not found" });
  }

  try {
    const cues = await getTranscript(id);
    // An empty transcript is a normal answer, not an error: most videos have
    // never been transcribed, and the watch page renders nothing for them.
    return res.json({ cues });
  } catch (err) {
    console.error("Could not load a transcript:", err);
    return res.status(502).json({ error: "Could not load the transcript" });
  }
}

export default withMonitorApi(handler);
