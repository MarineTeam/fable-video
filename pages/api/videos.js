// Paginated video library for approved viewers, with title search and
// collection filtering. Rate-limited; only ready (fully encoded) videos are
// returned, capped at the admin-configured homepage count and sorted by the
// admin's custom order (new uploads float to the top).
import { requireApproved } from "../../lib/guard";
import { allowRequest } from "../../lib/ratelimit";
import { listAllVideos, thumbnailsEnabled, thumbnailUrl, videoState } from "../../lib/bunny";
import { applyOrder } from "../../lib/order";
import { getOrder, getSettings } from "../../lib/store";

const PER_PAGE = 10;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const email = await requireApproved(req, res);
  if (!email) return;

  if (!(await allowRequest("videos", email, 60, "1 m"))) {
    return res.status(429).json({ error: "Too many requests — slow down a little" });
  }

  try {
    const [all, order, settings] = await Promise.all([
      listAllVideos(),
      getOrder().catch(() => []),
      getSettings().catch(() => ({ videoCount: 30 })),
    ]);

    let videos = applyOrder(
      all.filter((video) => videoState(video) === "ready"),
      order
    ).slice(0, settings.videoCount);

    const q = String(req.query.q || "").trim().toLowerCase();
    if (q) {
      videos = videos.filter((video) =>
        String(video.title || "").toLowerCase().includes(q)
      );
    }
    const collection = String(req.query.collection || "").trim();
    if (collection) {
      videos = videos.filter((video) => video.collectionId === collection);
    }

    const total = videos.length;
    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
    const page = Math.min(
      Math.max(parseInt(req.query.page, 10) || 1, 1),
      totalPages
    );
    const items = videos
      .slice((page - 1) * PER_PAGE, page * PER_PAGE)
      .map((video) => ({
        id: video.guid,
        title: video.title || "Untitled",
        length: video.length || 0,
        collectionId: video.collectionId || "",
        thumbnail: thumbnailUrl(video),
      }));

    return res.json({
      videos: items,
      page,
      totalPages,
      total,
      thumbnails: thumbnailsEnabled(),
    });
  } catch {
    return res.status(502).json({ error: "Could not load the video library" });
  }
}
