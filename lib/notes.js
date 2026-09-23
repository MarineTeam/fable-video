// Sermon notes: admin-authored free text attached to a video — an outline,
// the passage it covers, who spoke. The point is findability: "that talk on
// Philippians" is searchable months later even though the title never said
// Philippians.
//
// PURE MODULE — no Redis import, for the same bundle reason as lib/chapters.js
// (the watch page and the homepage both render/search this in the browser).
// Storage lives in lib/videoMeta.js.
//
// Notes are rendered as PLAIN TEXT with line breaks preserved, never as
// markup. Scripture references in them ("Phil 4:13") are read by
// lib/scripture.js, and the search predicate below uses that so a passage
// search finds a passage however it was written.

import { parsePassageQuery, passageMatches, videoReferences } from "./scripture";
import { queryStems, stemSet, stemsMatch } from "./stem";

export const MAX_NOTES_LENGTH = 2000;

// Everything in the Cc/Cf control classes except the newlines we want to keep.
const CONTROL_EXCEPT_NEWLINE = /[^\P{Cc}\n]|\p{Cf}/gu;

// Normalizes admin input: CRLF to LF, control characters out, trailing
// whitespace off each line, runs of blank lines collapsed to one, clamped to
// the stored maximum. Returns null for "no notes" so the store can delete the
// row rather than keep an empty string — absence is the additive default.
export function cleanNotes(value) {
  const text = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_EXCEPT_NEWLINE, " ")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return null;
  return text.length > MAX_NOTES_LENGTH ? text.slice(0, MAX_NOTES_LENGTH).trim() : text;
}

// Splits notes into lines for rendering. The watch page maps these to
// elements rather than injecting a string with <br>, so nothing an admin
// types is ever interpreted as markup.
export function notesLines(notes) {
  return String(notes || "").split("\n");
}

// Search predicate shared by the homepage filter. Matching now spans the
// title AND the notes; it does NOT widen which videos a viewer receives —
// the list this runs over has already been filtered by group scope and
// schedule on the server (lib/videoList.js), so a viewer can only ever search
// within what they were already allowed to see.
//
// A query that IS a scripture reference ("Philippians", "phil 2", "Phil
// 2:1-11") also matches any video whose title or notes cite an overlapping
// passage, in any spelling. That only ADDS matches — everything the plain
// substring rule matched still matches — so search does not change under an
// admin who has learned it; it just stops missing "Phil" when you typed
// "Philippians".
//
// A query's WORDS also match by stem (lib/stem.js): "baptism" finds
// "baptised", "praying" finds "prayed" — in title or notes, every word
// somewhere, in any order. Also additive.
export function videoMatchesQuery(video, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  if (String(video?.title || "").toLowerCase().includes(q)) return true;
  if (String(video?.notes || "").toLowerCase().includes(q)) return true;
  const parsed = cachedParse(video);
  // A query that is a passage means that passage, precisely — word stems
  // would read "Philippians 2" as the word "philippians" and find the whole
  // book. So a passage query is answered by passage overlap alone.
  const passage = parsePassageQuery(query);
  if (passage) return passageMatches(parsed.refs, passage);
  return stemsMatch(parsed.stems, queryStems(query));
}

// The homepage re-runs the predicate on every debounced keystroke over the
// whole loaded list; parsing each video's notes (references and word stems)
// each time is wasted work. A
// WeakMap keyed on the video object, checked against the text it was parsed
// from, so an edited video is re-read rather than served stale.
const parseCache = new WeakMap();
const EMPTY = { refs: [], stems: new Set() };
function cachedParse(video) {
  if (!video || typeof video !== "object") return EMPTY;
  const text = `${video.title || ""}\n${video.notes || ""}`;
  const hit = parseCache.get(video);
  if (hit && hit.text === text) return hit;
  const entry = { text, refs: videoReferences(video), stems: stemSet(text) };
  parseCache.set(video, entry);
  return entry;
}
