// Storage for parsed transcripts. Parsing lives in the pure module
// (lib/captions.js) so the watch page can import it without pulling Redis —
// and therefore Node built-ins — into the browser bundle. Same split as
// lib/chapters.js vs lib/videoMeta.js.
//
// TWO hashes, not one, and the reason is the access pattern rather than
// tidiness:
//
//   k("transcripts")     video id -> JSON cue array, with timings
//   k("transcript_text") video id -> the same words as one normalised string
//
// The watch page wants one video's cues and reads a single field (hget). The
// library search wants "which videos said this?" across everything, which is
// one hgetall — and a transcript's cues are bulky (a 90-minute service is
// ~1,500 cues with two timings each). Pulling all of that on every search, to
// use none of the timings, is the kind of cost that only shows up once the
// library is large. The text hash is a fraction of the size and is the only
// thing search touches.
//
// ADDITIVE BY DEFAULT, like lib/videoMeta.js: no row means no transcript and
// the video behaves exactly as it did before. Nothing here decides who may see
// a video; it only decorates one they can already reach.
import { k, redis } from "./redis";
import { MAX_CUES, transcriptText } from "./captions";

const cuesKey = () => k("transcripts");
const textKey = () => k("transcript_text");

function videoId(id) {
  return String(id || "").trim();
}

function parseCues(raw) {
  if (!raw) return [];
  try {
    // Upstash may hand back an already-parsed value or a JSON string depending
    // on what was written; accept both rather than assuming.
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(value)) return [];
    return value
      .filter((cue) => cue && typeof cue.text === "string")
      .slice(0, MAX_CUES)
      .map((cue) => ({
        start: Number(cue.start) || 0,
        end: Number(cue.end) || 0,
        text: cue.text,
      }));
  } catch (err) {
    // A corrupt row is not a reason to break the watch page — it reads as "no
    // transcript", exactly like a missing one.
    console.error("Could not parse a stored transcript:", err);
    return [];
  }
}

// One video's cues, or [] when it has never been transcribed.
export async function getTranscript(id) {
  const key = videoId(id);
  if (!key) return [];
  const raw = await redis().hget(cuesKey(), key);
  return parseCues(raw);
}

// video id -> plain transcript text, for library search. Deliberately NOT the
// cue array — see the two-hash note above.
export async function getTranscriptTextMap() {
  const all = (await redis().hgetall(textKey())) || {};
  const out = {};
  for (const [id, value] of Object.entries(all)) {
    if (typeof value === "string" && value) out[id] = value;
  }
  return out;
}

// Which video ids have a transcript at all — drives the "transcribed" badge in
// the admin Videos tab without pulling any transcript bodies.
export async function getTranscribedIds() {
  const ids = await redis().hkeys(cuesKey());
  return new Set(Array.isArray(ids) ? ids.map(String) : []);
}

// Writes both hashes together. Callers pass cues from parseVtt().
export async function setTranscript(id, cues) {
  const key = videoId(id);
  if (!key) return;
  const list = Array.isArray(cues) ? cues.slice(0, MAX_CUES) : [];
  if (!list.length) return clearTranscript(key);
  await redis().hset(cuesKey(), { [key]: JSON.stringify(list) });
  await redis().hset(textKey(), { [key]: transcriptText(list) });
}

export async function clearTranscript(id) {
  const key = videoId(id);
  if (!key) return;
  await redis().hdel(cuesKey(), key);
  await redis().hdel(textKey(), key);
}
