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
// markup. Scripture-reference parsing (turning "Phil 4:13" into structured
// data) is deliberately not here: book abbreviations, ranges and translations
// make it far deeper than it looks, and it is not needed for the core value.

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
export function videoMatchesQuery(video, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  if (String(video?.title || "").toLowerCase().includes(q)) return true;
  return String(video?.notes || "").toLowerCase().includes(q);
}
