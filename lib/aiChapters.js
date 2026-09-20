// bunny.net's AI chapter suggestions, turned into this repo's chapter shape.
//
// PURE MODULE — no Redis, no fetch, for the same reason as lib/chapters.js:
// suggestions are rendered in the admin's browser, so anything imported here
// lands in the client bundle. Fetching the video is the route's job.
//
// SUGGESTIONS ARE NOT CHAPTERS. Nothing in this file writes anywhere, and the
// route that calls it writes nothing either. A suggested list becomes real
// only when an admin loads it into the chapters textarea and presses Save,
// which goes through exactly the same parseChapters path a typed list does.
// That is the whole feature: bunny can generate chapters from the transcript,
// but a second writer for `fablevideo:chapters` is how hand-written chapters
// get silently replaced, so the AI may propose and only a person may accept.
//
// SHAPE, and what is guessed about it. bunny's video object documents chapters
// as `[{ title, start, end }]` with the times in SECONDS, and moments as
// `[{ label, timestamp }]`. `title`/`start` are the documented names; `label`,
// `text`, `timestamp` and `time` are accepted as fallbacks because this has
// never run against a live transcription job — a field spelled differently
// than the docs say should cost one wrong label, not an empty list with no
// explanation. Whatever cannot be read is REPORTED, never dropped quietly: the
// admin has to be able to tell "bunny generated nothing" from "bunny generated
// something we could not read".
import { MAX_CHAPTERS, MAX_LABEL_LENGTH, cleanLabel } from "./chapters";

// Documented name first; the rest are the defensive fallbacks described above.
const TIME_KEYS = ["start", "timestamp", "time"];
const LABEL_KEYS = ["title", "label", "text"];

function readTime(entry) {
  for (const key of TIME_KEYS) {
    const value = entry?.[key];
    // Strings only when they are wholly numeric: `Number("")` is 0, which
    // would turn a missing field into a chapter at 0:00.
    if (value === null || value === undefined || value === "") continue;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return seconds;
  }
  return NaN;
}

function readLabel(entry) {
  for (const key of LABEL_KEYS) {
    const label = cleanLabel(entry?.[key]);
    if (label) return label;
  }
  return "";
}

// Reads a bunny video object's `chapters` (falling back to `moments`, which is
// the same idea under another name) into { chapters, ignored }.
//
// The return shape deliberately mirrors parseChapters: the admin UI already
// knows how to report what it could not read, and a suggestion that was
// skipped deserves the same treatment as a typed line that was skipped.
export function suggestedChapters(video) {
  const raw = Array.isArray(video?.chapters) && video.chapters.length
    ? video.chapters
    : Array.isArray(video?.moments)
      ? video.moments
      : [];

  const chapters = [];
  const ignored = [];

  raw.forEach((entry, index) => {
    const position = index + 1;
    const label = readLabel(entry);

    if (chapters.length >= MAX_CHAPTERS) {
      ignored.push({
        index: position,
        text: label,
        reason: `over the ${MAX_CHAPTERS}-chapter limit`,
      });
      return;
    }

    const seconds = readTime(entry);
    if (!Number.isFinite(seconds) || seconds < 0) {
      ignored.push({ index: position, text: label, reason: "no usable start time" });
      return;
    }
    if (!label) {
      ignored.push({
        index: position,
        text: "",
        reason: `no title (at ${Math.floor(seconds)}s)`,
      });
      return;
    }

    chapters.push({ t: Math.floor(seconds), label: label.slice(0, MAX_LABEL_LENGTH) });
  });

  // bunny returns these in time order already, but sorting makes that an
  // invariant of this function rather than a property of the upstream API.
  chapters.sort((x, y) => x.t - y.t);
  return { chapters, ignored };
}

// Whether a suggested list would change anything. Used by the admin UI to say
// "these match what you already have" instead of offering a replacement that
// does nothing — and to make "Accept" feel safe, because the one case where it
// costs the admin nothing is named out loud.
export function sameChapters(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  return left.every((chapter, index) => {
    const other = right[index];
    return Math.floor(Number(chapter?.t)) === Math.floor(Number(other?.t))
      && String(chapter?.label || "") === String(other?.label || "");
  });
}
