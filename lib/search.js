// Library-wide search: the part of searching that the homepage cannot do for
// itself.
//
// PURE MODULE — no Redis, no fetch. The homepage imports it to decide what it
// already holds, and the route imports it to decide the rest, so both halves
// of a search agree about what "matches" means. Same bundle rule as
// lib/notes.js and lib/chapters.js.
//
// WHY A SERVER SEARCH EXISTS AT ALL. The homepage ships one page of videos and
// filters them in the browser — no round trip per keystroke, which is the
// whole reason search feels instant. But that page is capped at the admin's
// homepage count, so a video past the cap could not be found by searching for
// it: the library had it, the search could not reach it. This closes that,
// and deliberately does not replace the client-side half.
//
// THE MATCHERS ARE NOT NEW. Title and notes go through videoMatchesQuery from
// lib/notes.js, the same predicate the browser runs; the spoken half goes
// through the normalize/compare that the transcript search already used. This
// feature is about REACH, not about changing what matches — so the two halves
// keep their existing (slightly different) matching rules rather than being
// quietly unified underneath an admin who has learned how search behaves.
import { videoMatchesQuery } from "./notes";

// Long enough to be a real query against a transcript. One or two characters
// match most of any transcript, which is a slow answer that helps nobody.
// Titles and notes are short, so they match from one character as before.
export const MIN_TRANSCRIPT_QUERY = 3;

// The most results one search returns. A query like "the" legitimately matches
// every sermon ever recorded; sending all of them helps nobody and is a
// payload the homepage never asked for. Truncation is REPORTED, never silent.
export const MAX_RESULTS = 60;

const APOSTROPHE = /['‘’ʼ]/g;
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;

// The spoken-word normalizer, identical to the one the transcript store uses:
// apostrophes are deleted so "Christ's" and "Christs" match, other punctuation
// becomes a space so "end. Start" does not become one word.
export function normalizeSpoken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(APOSTROPHE, "")
    .replace(PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function spokenMatches(text, query) {
  const needle = normalizeSpoken(query);
  if (needle.length < MIN_TRANSCRIPT_QUERY) return false;
  return normalizeSpoken(text).includes(needle);
}

// Whether a video matches at all, by title, notes or what was said in it.
export function videoMatches(video, query, spokenText) {
  if (videoMatchesQuery(video, query)) return true;
  return spokenMatches(spokenText, query);
}

// Searches an ALREADY-AUTHORIZED list. This function does no access checking
// whatsoever and must never be handed a list the caller has not already
// filtered — the route feeds it the same scope-and-schedule-filtered library
// /api/videos serves, minus only the display cap.
//
// Input order is preserved, so results come back in library order rather than
// by a relevance score nobody asked for: an admin arranges the library
// deliberately, and a search that reshuffles it is harder to scan, not easier.
export function searchLibrary({ videos = [], transcripts = {}, query = "", limit = MAX_RESULTS } = {}) {
  const q = String(query || "").trim();
  if (!q) return { videos: [], truncated: false, total: 0 };

  const list = Array.isArray(videos) ? videos : [];
  const texts = transcripts && typeof transcripts === "object" ? transcripts : {};

  const hits = list.filter((video) => videoMatches(video, q, texts[video?.id]));
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_RESULTS;
  return {
    videos: hits.slice(0, cap),
    truncated: hits.length > cap,
    total: hits.length,
  };
}

// The longest search a link may carry into the homepage. A passage is a few
// dozen characters; this only stops a crafted URL filling the search box.
export const MAX_LINKED_QUERY = 200;

// What a ?q= in the homepage URL searches for, or "" for nothing. Strings
// only: Next hands a repeated parameter over as an array, and joining one
// would search for text nobody typed. The box ends up holding exactly this,
// and the search it runs is the ordinary one — over the viewer's own
// authorized library — so a link can pre-fill a search but not widen one.
export function linkedQuery(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, MAX_LINKED_QUERY).trim();
}

// The homepage link that searches for a passage.
export function passageSearchHref(label) {
  return `/?q=${encodeURIComponent(String(label || ""))}`;
}
