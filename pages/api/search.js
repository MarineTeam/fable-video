// Search the WHOLE library, not just the page the homepage is holding.
//
//   GET ?q=...  -> { videos: [...], total, truncated }
//
// The homepage filters its loaded list in the browser, which is why search
// feels instant and costs no round trip per keystroke. That list is capped at
// the admin's homepage count, so before this route a video past the cap could
// not be found by searching for it — the library had it, the search could not
// reach it. This is the half the browser cannot do for itself, and it does not
// replace the other half: the client still matches locally and merges.
//
// A DELIBERATE CHANGE OF POSTURE, stated plainly. /api/transcript-search (which
// this replaces) returned IDS ONLY, so that even if it were wrong the client
// could only ever widen a list it already held — an id it did not hold matched
// nothing. That defence cannot survive here, because the entire point is to
// return videos the client does NOT hold. So the filtering below is
// load-bearing, exactly as it already is in /api/videos, and is tested as
// such rather than backstopped by the shape of the response.
//
// What that filtering is: the SAME pipeline /api/videos uses — group scope,
// publish window, ready-only — minus only the display cap, which is a display
// limit and not access control. A viewer can therefore find anything they were
// already entitled to watch, and nothing else.
import { requireAccess } from "../../lib/guard";
import { oneTrimmed } from "../../lib/params";
import { allowRequest } from "../../lib/ratelimit";
import { fetchVideoLibrary } from "../../lib/videoList";
import { getTranscriptTextMap, matchingTranslatedIds } from "../../lib/captionsStore";
import { MAX_RESULTS, searchLibrary } from "../../lib/search";
import { withMonitorApi } from "../../lib/monitor";

async function handler(req, res) {
  const access = await requireAccess(req, res);
  if (!access) return;

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Debounced in the browser, but the budget is per viewer and a search reads
  // the whole library — the same shape as /api/videos, so the same 60/minute.
  if (!(await allowRequest("search", access.email, 60, "1 m"))) {
    return res.status(429).json({ error: "Too many searches — try again shortly" });
  }

  const query = oneTrimmed(req.query.q);
  // An empty query is not an error and not "everything": the homepage already
  // shows the library when nothing is typed.
  if (!query) return res.json({ videos: [], total: 0, truncated: false });

  let library;
  try {
    library = await fetchVideoLibrary(access.videoScope, { cap: false, groupIds: access.groupIds });
  } catch (err) {
    console.error("Could not read the library for a search:", err);
    return res.status(502).json({ error: "Could not search the library" });
  }

  // Transcripts are the optional half. Losing them costs this query its spoken
  // matches and nothing else — the title and notes search still answers, which
  // is strictly better than a 502 that makes the search box look broken.
  let transcripts = {};
  try {
    transcripts = await getTranscriptTextMap();
  } catch (err) {
    console.error("Could not read transcripts for search:", err);
  }
  // Translations: matched inside Redis, ids only (lib/captionsStore.js). Same
  // contract as the default track — losing it costs only those matches.
  let translatedIds = new Set();
  try {
    translatedIds = await matchingTranslatedIds(query);
  } catch (err) {
    console.error("Could not search translated transcripts:", err);
  }

  const result = searchLibrary({
    videos: library.videos,
    transcripts,
    translatedIds,
    query,
    limit: MAX_RESULTS,
  });

  return res.json({
    videos: result.videos,
    total: result.total,
    // Reported rather than silent: a viewer who searches "the" and gets 60
    // results should be told there are more, not left thinking that is all
    // the library holds.
    truncated: result.truncated,
    // Separate from `truncated`: the LIBRARY was larger than one read, so the
    // oldest videos were not searched at all. Said, not hidden.
    libraryTruncated: Boolean(library.libraryTruncated),
    thumbnails: library.thumbnails,
  });
}

export default withMonitorApi(handler);
