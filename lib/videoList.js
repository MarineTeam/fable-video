// Fetches the viewer-facing video library: ordered, ready-only, capped at
// the admin's homepage count, with signed thumbnail URLs. Search, collection
// filtering, and pagination all happen client-side against this one list —
// no network round trip per keystroke or chip click. Sermon notes ride along
// for the same reason — search matches them as well as titles.
//
// `videoScope` is the caller's group restriction from lib/roles.js:
// null/undefined means unrestricted, an array means those ids and no others.
// It is applied BEFORE the homepage count is applied, so a restricted viewer
// still gets a full page of the videos they are allowed to see rather than
// whatever survives capping the unfiltered library.
import { listAllVideosWithStatus, thumbnailsEnabled, thumbnailUrl, videoState } from "./bunny";
import { applyOrder } from "./order";
import { getOrder, getSettings } from "./store";
import { getScheduleMap, isLiveFor } from "./schedule";
import { getNotesMap } from "./videoMeta";

// `cap` is the admin's homepage video count. It is a DISPLAY limit, not access
// control — every video that survives the scope and schedule filters above is
// one this viewer is entitled to. /api/search passes { cap: false } so a search
// can reach the whole authorized library rather than only the first page,
// which is the one thing the browser-side search could never do for itself.
// `groupIds`: the viewer's groups, for per-group publish windows. Omitting it
// applies the default windows only — the SAFE direction, since group windows
// can only ever add visibility (lib/schedule.js isLiveFor).
export async function fetchVideoLibrary(videoScope = null, { cap = true, groupIds = [] } = {}) {
  const [library, order, settings, schedules, notes] = await Promise.all([
    listAllVideosWithStatus(),
    getOrder().catch(() => []),
    getSettings().catch(() => ({ videoCount: 30 })),
    // A schedule lookup failure must not blank the library — an unreadable
    // schedule map means "no schedule constraints", matching the behavior of
    // a video that simply has no schedule. This is the opposite call from
    // group scope (which fails closed) because a schedule hides ALREADY
    // approved content from someone already entitled to the library, rather
    // than deciding what they are entitled to.
    getScheduleMap().catch(() => ({})),
    // Notes are searchable decoration, not access control — an unreadable
    // notes hash costs search coverage for one page load and nothing else.
    getNotesMap().catch(() => ({})),
  ]);

  const all = library.videos;
  const allowed = new Set(Array.isArray(videoScope) ? videoScope : []);
  const now = Date.now();
  const visible = all.filter(
    (video) =>
      videoState(video) === "ready" &&
      (videoScope === null || videoScope === undefined || allowed.has(video.guid)) &&
      isLiveFor(schedules[video.guid], groupIds, now)
  );

  const ordered = applyOrder(visible, order);
  const videos = (cap ? ordered.slice(0, settings.videoCount) : ordered)
    .map((video) => ({
      id: video.guid,
      title: video.title || "Untitled",
      length: video.length || 0,
      collectionId: video.collectionId || "",
      // Carried for the podcast feed's <pubDate>. Kept on this one shared
      // path rather than re-fetched separately, so the feed can never drift
      // from the library the website shows.
      dateUploaded: video.dateUploaded || null,
      thumbnail: thumbnailUrl(video),
      // Carried so the client-side search can match notes as well as titles
      // without a round trip per keystroke — the same reason the whole list
      // ships at once. Notes are clamped to MAX_NOTES_LENGTH at write time,
      // so the payload stays bounded by the homepage video count.
      notes: notes[video.guid] || null,
    }));

  // `libraryTruncated`: the library is larger than one whole-library read
  // (lib/bunny.js MAX_LIBRARY_PAGES), so the oldest videos are not in it.
  return { videos, thumbnails: thumbnailsEnabled(), libraryTruncated: Boolean(library.truncated) };
}
