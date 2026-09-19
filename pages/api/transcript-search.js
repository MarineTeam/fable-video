// Library search by what was SAID, rather than by title or notes.
//
//   GET ?q=...  -> { ids: [videoGuid, ...] }
//
// Why this is a server call at all, when the homepage searches titles and
// notes entirely client-side: notes are clamped to a few hundred characters,
// so shipping every video's notes to the browser is cheap. A transcript is
// not — a 90-minute service is tens of kilobytes of text, and the homepage
// carries up to `videoCount` videos, so shipping transcripts the same way
// would put megabytes into every page load to support a search most visits
// never run.
//
// It returns IDS ONLY, never titles or matching lines, and the client uses
// them purely to widen a list it already holds. The homepage's existing
// guarantee is that searching narrows an already-authorized list and can
// never surface a video the viewer may not see; keeping this endpoint to
// bare ids means that guarantee still holds even if this route were wrong,
// because an id the client does not already have simply matches nothing.
//
// The scope filter below is still applied, because an id is itself an answer
// to "does a video containing this phrase exist?".
import { requireAccess } from "../../lib/guard";
import { oneTrimmed } from "../../lib/params";
import { scopeAllows } from "../../lib/roles";
import { getTranscriptTextMap } from "../../lib/captionsStore";
import { withMonitorApi } from "../../lib/monitor";

// Long enough to be a real query. One or two characters match most of a
// transcript, which is a slow answer that helps nobody.
const MIN_QUERY = 3;

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['‘’ʼ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function handler(req, res) {
  const access = await requireAccess(req, res);
  if (!access) return;

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const needle = normalize(oneTrimmed(req.query.q));
  if (needle.length < MIN_QUERY) return res.json({ ids: [] });

  let map;
  try {
    map = await getTranscriptTextMap();
  } catch (err) {
    // Search coverage is decoration: losing transcript matches costs this one
    // query its extra results, and the client still has its title/notes
    // search. Never a 502 that would make the search box look broken.
    console.error("Could not read transcripts for search:", err);
    return res.json({ ids: [] });
  }

  const ids = Object.entries(map)
    .filter(([id, text]) => scopeAllows(access.videoScope, id) && normalize(text).includes(needle))
    .map(([id]) => id);

  return res.json({ ids });
}

export default withMonitorApi(handler);
