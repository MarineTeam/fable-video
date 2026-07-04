// Applies the admin's saved custom order to a list of bunny.net videos.
// Videos not yet placed in the saved order (i.e. new uploads) float to the
// top, newest first, until the admin positions them.
export function applyOrder(videos, order) {
  const position = new Map((order || []).map((id, index) => [id, index]));
  const placed = [];
  const unplaced = [];
  for (const video of videos || []) {
    if (position.has(video.guid)) placed.push(video);
    else unplaced.push(video);
  }
  placed.sort((a, b) => position.get(a.guid) - position.get(b.guid));
  unplaced.sort(
    (a, b) => new Date(b.dateUploaded || 0) - new Date(a.dateUploaded || 0)
  );
  return [...unplaced, ...placed];
}
