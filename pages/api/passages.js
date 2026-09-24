// The books of the Bible this viewer's library cites, for "Browse by book".
//
//   GET -> { books: [{ book: "Philippians", count: 3 }, ...] }
//
// Built over the SAME scoped library /api/search uses — fetchVideoLibrary
// with the viewer's group scope, publish window and ready-only filter, minus
// only the display cap. That is load-bearing: a count is itself information
// ("Philippians (3)" says three videos exist), so an index over videos the
// viewer cannot see would leak what the scope hides. Clicking a book runs the
// ordinary passage search, which reads the same titles and notes, so every
// book listed here finds at least one video.
import { requireAccess } from "../../lib/guard";
import { allowRequest } from "../../lib/ratelimit";
import { fetchVideoLibrary } from "../../lib/videoList";
import { bookIndex } from "../../lib/scripture";
import { withMonitorApi } from "../../lib/monitor";

async function handler(req, res) {
  const access = await requireAccess(req, res);
  if (!access) return;

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Reads the whole library like a search does, so the same budget.
  if (!(await allowRequest("passages", access.email, 60, "1 m"))) {
    return res.status(429).json({ error: "Too many requests — try again shortly" });
  }

  let library;
  try {
    library = await fetchVideoLibrary(access.videoScope, { cap: false, groupIds: access.groupIds });
  } catch (err) {
    console.error("Could not read the library for the book index:", err);
    return res.status(502).json({ error: "Could not load the book list" });
  }
  return res.json({ books: bookIndex(library.videos) });
}

export default withMonitorApi(handler);
