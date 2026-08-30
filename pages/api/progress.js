// Per-viewer playback progress / watch history.
//   GET ?videoId=...  -> saved position for one video (used by the player)
//   GET               -> continue-watching list, enriched with video details
//   GET ?all=1        -> full watch history (every video with any progress,
//                        finished or not, uncapped) for the "My activity" page
//   GET ?all=1&email=someone@x.com
//                     -> an admin looking up an approved viewer's full
//                        history instead of their own (admin-only; the
//                        target must itself be an approved viewer or admin)
//   POST              -> save progress { videoId, t, d }
import { requireAccess } from "../../lib/guard";
import { normalizeEmail } from "../../lib/auth";
import { CAP, hasCapability, resolveAccess, scopeAllows } from "../../lib/roles";
import { getProgress, saveProgress } from "../../lib/store";
import { listAllVideos, thumbnailUrl } from "../../lib/bunny";
import { withMonitorApi } from "../../lib/monitor";

const MAX_CONTINUE_ITEMS = 8;

async function handler(req, res) {
  const access = await requireAccess(req, res);
  if (!access) return;
  const email = access.email;

  if (req.method === "GET") {
    const videoId = String(req.query.videoId || "").trim();
    const all = req.query.all === "1" || req.query.all === "true";
    const requestedEmail = req.query.email ? normalizeEmail(req.query.email) : null;

    let target = email;
    if (requestedEmail && requestedEmail !== email) {
      if (!hasCapability(access, CAP.INSIGHTS)) {
        return res.status(403).json({ error: "You don't have permission to do that" });
      }
      let targetApproved = false;
      try {
        targetApproved = (await resolveAccess(requestedEmail)).approved;
      } catch (err) {
        console.error("Could not resolve the requested viewer:", err);
        targetApproved = false;
      }
      if (!targetApproved) {
        return res.status(404).json({ error: "That address isn't an approved viewer" });
      }
      target = requestedEmail;
    }

    try {
      const progress = await getProgress(target);
      if (videoId) {
        return res.json({ progress: progress[videoId] || null });
      }

      let entries = Object.entries(progress)
        .map(([id, entry]) => ({ videoId: id, ...entry }))
        .filter((e) => e.t > 10 && e.d > 0);

      entries = all
        // Full history: every video ever progressed on, finished included.
        ? entries.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
        // Continue-watching: only what's still unfinished, capped.
        : entries
            .filter((e) => e.t < e.d * 0.95)
            .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
            .slice(0, MAX_CONTINUE_ITEMS);

      if (!entries.length) return res.json({ items: [] });

      const videos = await listAllVideos();
      const byId = new Map(videos.map((v) => [v.guid, v]));
      const items = entries
        // Group scoping applies to the caller's own history: progress
        // recorded before a restriction was applied must not keep surfacing
        // a video they may no longer see. Staff have a null scope, so an
        // admin looking up someone else's history still sees all of it.
        .filter((e) => byId.has(e.videoId) && scopeAllows(access.videoScope, e.videoId))
        .map((e) => {
          const video = byId.get(e.videoId);
          const completed = e.t >= e.d * 0.95;
          return {
            videoId: e.videoId,
            t: e.t,
            d: e.d,
            percent: Math.min(100, Math.round((e.t / e.d) * 100)),
            completed,
            updatedAt: e.at || null,
            title: video.title || "Untitled",
            thumbnail: thumbnailUrl(video),
          };
        });
      return res.json({ items });
    } catch (err) {
      console.error("Could not load watch history:", err);
      return res.status(502).json({ error: "Could not load watch history" });
    }
  }

  if (req.method === "POST") {
    const { videoId, t, d } = req.body || {};
    const position = Number(t);
    const duration = Number(d);
    if (
      !videoId ||
      typeof videoId !== "string" ||
      videoId.length > 100 ||
      !Number.isFinite(position) ||
      !Number.isFinite(duration) ||
      position < 0 ||
      duration <= 0
    ) {
      return res.status(400).json({ error: "Invalid progress payload" });
    }
    try {
      await saveProgress(email, videoId, {
        t: Math.floor(position),
        d: Math.floor(duration),
        at: new Date().toISOString(),
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error("Could not save progress:", err);
      return res.status(502).json({ error: "Could not save progress" });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
