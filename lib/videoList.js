// Fetches the viewer-facing video library: ordered, ready-only, capped at
// the admin's homepage count, with signed thumbnail URLs. Search, collection
// filtering, and pagination all happen client-side against this one list —
// no network round trip per keystroke or chip click.
//
// `videoScope` is the caller's group restriction from lib/roles.js:
// null/undefined means unrestricted, an array means those ids and no others.
// It is applied BEFORE the homepage count is applied, so a restricted viewer
// still gets a full page of the videos they are allowed to see rather than
// whatever survives capping the unfiltered library.
import { listAllVideos, thumbnailsEnabled, thumbnailUrl, videoState } from "./bunny";
import { applyOrder } from "./order";
import { getOrder, getSettings } from "./store";
import { getScheduleMap, isLive } from "./schedule";

export async function fetchVideoLibrary(videoScope = null) {
  const [all, order, settings, schedules] = await Promise.all([
    listAllVideos(),
    getOrder().catch(() => []),
    getSettings().catch(() => ({ videoCount: 30 })),
    // A schedule lookup failure must not blank the library — an unreadable
    // schedule map means "no schedule constraints", matching the behavior of
    // a video that simply has no schedule. This is the opposite call from
    // group scope (which fails closed) because a schedule hides ALREADY
    // approved content from someone already entitled to the library, rather
    // than deciding what they are entitled to.
    getScheduleMap().catch(() => ({})),
  ]);

  const allowed = new Set(Array.isArray(videoScope) ? videoScope : []);
  const now = Date.now();
  const visible = all.filter(
    (video) =>
      videoState(video) === "ready" &&
      (videoScope === null || videoScope === undefined || allowed.has(video.guid)) &&
      isLive(schedules[video.guid], now)
  );

  const videos = applyOrder(visible, order)
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
