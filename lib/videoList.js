// Shared video-listing query (ordering, filtering, pagination) used by both
// the public API route and the homepage's server-rendered initial page, so
// the two stay in sync from one implementation.
import { listAllVideos, thumbnailsEnabled, thumbnailUrl, videoState } from "./bunny";
import { applyOrder } from "./order";
import { getOrder, getSettings } from "./store";

const PER_PAGE = 10;

export async function fetchVideoPage({ page = 1, q = "", collection = "" } = {}) {
  const [all, order, settings] = await Promise.all([
    listAllVideos(),
    getOrder().catch(() => []),
    getSettings().catch(() => ({ videoCount: 30 })),
  ]);

  let videos = applyOrder(
    all.filter((video) => videoState(video) === "ready"),
    order
  ).slice(0, settings.videoCount);

  const query = q.trim().toLowerCase();
  if (query) {
    videos = videos.filter((video) =>
      String(video.title || "").toLowerCase().includes(query)
    );
  }
  if (collection) {
    videos = videos.filter((video) => video.collectionId === collection);
  }

  const total = videos.length;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const items = videos
    .slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)
    .map((video) => ({
      id: video.guid,
      title: video.title || "Untitled",
      length: video.length || 0,
      collectionId: video.collectionId || "",
      thumbnail: thumbnailUrl(video),
    }));

  return {
    videos: items,
    page: safePage,
    totalPages,
    total,
    thumbnails: thumbnailsEnabled(),
  };
}
