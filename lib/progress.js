// Rules for per-viewer playback progress (k("progress", email)), with no Redis.
//
// The player saves a position every few seconds, and before these rules the
// route accepted ANY string up to 100 characters as a video id, with no rate
// limit. A signed-in viewer could therefore grow their own progress hash
// without bound. Three bounds now apply, each cheap enough for a request that
// fires every eight seconds:
//
//   * the id must look like a bunny video id (isProgressVideoId);
//   * the route rate-limits saves (pages/api/progress.js);
//   * the hash holds at most MAX_PROGRESS_ENTRIES videos. A save for a NEW
//     video at the cap drops the least recently watched entries first
//     (progressToEvict), so resume keeps working for what someone is watching
//     now — refusing instead would quietly break it after enough years.

// Matches the whole-library read bound (lib/bunny.js MAX_LIBRARY_PAGES × 100):
// nobody can be part-way through more videos than the library holds.
export const MAX_PROGRESS_ENTRIES = 1000;

// bunny video ids are GUIDs; letters, digits and dashes, well under 64.
const VIDEO_ID = /^[A-Za-z0-9-]{1,64}$/;
export function isProgressVideoId(value) {
  return typeof value === "string" && VIDEO_ID.test(value);
}

// The ids to drop from `all` (videoId -> { t, d, at }) so that one more entry
// fits under `max`: the least recently updated first, and an entry with no
// readable time counts as the oldest of all.
export function progressToEvict(all, max = MAX_PROGRESS_ENTRIES) {
  const entries = Object.entries(all || {});
  const excess = entries.length - (max - 1);
  if (excess <= 0) return [];
  const when = (entry) => {
    const ms = Date.parse(entry?.at);
    return Number.isFinite(ms) ? ms : -Infinity;
  };
  return entries
    .sort(([idA, a], [idB, b]) => when(a) - when(b) || (idA < idB ? -1 : 1))
    .slice(0, excess)
    .map(([id]) => id);
}
