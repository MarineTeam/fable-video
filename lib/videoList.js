// Fetches the viewer-facing video library: ordered, ready-only, capped at
// the admin's homepage count, with signed thumbnail URLs. Search, collection
// filtering, and pagination all happen client-side against this one list —
// no network round trip per keystroke or chip click.
import { listAllVideos, thumbnailsEnabled, thumbnailUrl, videoState } from "./bunny";
import { applyOrder } from "./order";
import { getOrder, getSettings } from "./store";

export async function fetchVideoLibrary() {
  const [all, order, settings] = await Promise.all([
    listAllVideos(),
    getOrder().catch(() => []),
    getSettings().catch(() => ({ videoCount: 30 })),
  ]);

  const videos = applyOrder(
    all.filter((video) => videoState(video) === "ready"),
    order
  )
    .slice(0, settings.videoCount)
    .map((video) => ({
      id: video.guid,
      title: video.title || "Untitled",
      length: video.length || 0,
      collectionId: video.collectionId || "",
      thumbnail: thumbnailUrl(video),
    }));

  return { videos, thumbnails: thumbnailsEnabled() };
}
