// Per-viewer playback progress / watch history.
//   GET ?videoId=...  -> saved position for one video (used by the player)
//   GET               -> continue-watching list, enriched with video details
//   POST              -> save progress { videoId, t, d }
import { requireApproved } from "../../lib/guard";
import { getProgress, saveProgress } from "../../lib/store";
import { listAllVideos, thumbnailUrl } from "../../lib/bunny";

const MAX_CONTINUE_ITEMS = 8;

export default async function handler(req, res) {
  const email = await requireApproved(req, res);
  if (!email) return;

  if (req.method === "GET") {
    const videoId = String(req.query.videoId || "").trim();
    try {
      const progress = await getProgress(email);
      if (videoId) {
        return res.json({ progress: progress[videoId] || null });
      }

      const entries = Object.entries(progress)
        .map(([id, entry]) => ({ videoId: id, ...entry }))
        .filter((e) => e.t > 10 && e.d > 0 && e.t < e.d * 0.95)
        .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
        .slice(0, MAX_CONTINUE_ITEMS);

      if (!entries.length) return res.json({ items: [] });

      const videos = await listAllVideos();
      const byId = new Map(videos.map((v) => [v.guid, v]));
      const items = entries
        .filter((e) => byId.has(e.videoId))
        .map((e) => {
          const video = byId.get(e.videoId);
          return {
            videoId: e.videoId,
            t: e.t,
            d: e.d,
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
