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
import { MAX_CUES, isLanguageCode, normalizeLanguages, transcriptText } from "./captions";

const cuesKey = () => k("transcripts");
const textKey = () => k("transcript_text");
// Additional languages live in their OWN hash, keyed `${videoId}:${lang}`.
//
// They cannot share k("transcripts"): getTranscribedIds() reads its field
// names with hkeys to drive the admin "transcribed" badge, so a field named
// `vid-1:es` would be reported as a transcribed video that does not exist.
// Two shapes in one hash is a trap for the next person as much as for that
// function.
const altKey = () => k("transcripts_alt");
// videoId -> { default, all: [...] }. The index exists so a read knows which
// languages a video has WITHOUT scanning the alt hash, which is bulky for the
// same reason the cue hash is.
const langsKey = () => k("transcript_langs");

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
//
// With no language, or the video's default one, this reads exactly the field
// it always read — the default track stays where it was, so nothing about an
// existing transcript had to be migrated to add languages beside it.
export async function getTranscript(id, lang = null) {
  const key = videoId(id);
  if (!key) return [];
  const code = String(lang || "").trim().toLowerCase();
  if (!code || !isLanguageCode(code)) return parseCues(await redis().hget(cuesKey(), key));

  const { default: fallback } = await getTranscriptLanguages(key);
  if (code === fallback) return parseCues(await redis().hget(cuesKey(), key));
  return parseCues(await redis().hget(altKey(), `${key}:${code}`));
}

// Which languages a video has, and which is its default. Fails soft to "one
// unnamed track", which is what every transcript written before languages
// existed actually is.
export async function getTranscriptLanguages(id) {
  const key = videoId(id);
  if (!key) return { default: null, all: [] };
  let raw;
  try {
    raw = await redis().hget(langsKey(), key);
  } catch (err) {
    console.error("Could not read a video's transcript languages:", err);
    return { default: null, all: [] };
  }
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  const all = normalizeLanguages(value?.all);
  const preferred = String(value?.default || "").trim().toLowerCase();
  return { default: all.includes(preferred) ? preferred : all[0] || null, all };
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

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Writes both hashes together. Callers pass cues from parseVtt().
//
// This is the DEFAULT track and the only one library search reads — see the
// note in lib/search.js. Additional languages go through
// setTranscriptLanguage, which never touches the text hash.
export async function setTranscript(id, cues) {
  const key = videoId(id);
  if (!key) return;
  const list = Array.isArray(cues) ? cues.slice(0, MAX_CUES) : [];
  if (!list.length) return clearTranscript(key);
  await redis().hset(cuesKey(), { [key]: JSON.stringify(list) });
  await redis().hset(textKey(), { [key]: transcriptText(list) });
}

// One additional language. Deliberately does NOT write the text hash: search
// reads one language per video, and indexing every translation of the same
// sermon would multiply the search payload to return the same video.
export async function setTranscriptLanguage(id, lang, cues) {
  const key = videoId(id);
  const code = String(lang || "").trim().toLowerCase();
  if (!key || !isLanguageCode(code)) return;
  const list = Array.isArray(cues) ? cues.slice(0, MAX_CUES) : [];
  if (!list.length) return;
  await redis().hset(altKey(), { [`${key}:${code}`]: JSON.stringify(list) });
}

// Records which languages a video has. `defaultLang` names the track stored in
// the main hash, so a read knows which language it is getting when nobody asks
// for one.
export async function setTranscriptLanguages(id, defaultLang, langs) {
  const key = videoId(id);
  if (!key) return;
  const all = normalizeLanguages(langs);
  const preferred = String(defaultLang || "").trim().toLowerCase();
  if (!all.length) {
    await redis().hdel(langsKey(), key);
    return;
  }
  await redis().hset(langsKey(), {
    [key]: JSON.stringify({ default: all.includes(preferred) ? preferred : all[0], all }),
  });
}

export async function clearTranscript(id) {
  const key = videoId(id);
  if (!key) return;
  // The alt fields are named per language, so the index has to be read BEFORE
  // it is deleted or there is nothing left to say what to clean up. That is
  // the whole reason the index exists rather than being derived by scanning.
  const { all } = await getTranscriptLanguages(key);
  await redis().hdel(cuesKey(), key);
  await redis().hdel(textKey(), key);
  await redis().hdel(langsKey(), key);
  if (all.length) {
    await redis().hdel(altKey(), ...all.map((code) => `${key}:${code}`));
  }
}

// --- The queue of transcriptions waiting to be collected -------------------
//
//   k("transcribe_pending")  videoGuid -> epoch ms when it was queued
//
// A marker, not a job: nothing runs it. The admin video list checks these and
// ingests whatever bunny has finished (see lib/transcribeQueue.js for why).
// Every function here is best-effort — a marker that cannot be written costs
// the admin the second click they used to make anyway, and must never fail
// the request that spent the money.
export async function markTranscribePending(guid) {
  const id = String(guid || "").trim();
  if (!id) return;
  try {
    await redis().hset(k("transcribe_pending"), { [id]: Date.now() });
  } catch (err) {
    console.error("Could not record a pending transcription:", err);
  }
}

export async function getTranscribePending() {
  try {
    return (await redis().hgetall(k("transcribe_pending"))) || {};
  } catch (err) {
    console.error("Could not read the pending transcriptions:", err);
    return {};
  }
}

export async function clearTranscribePending(guids) {
  const ids = (Array.isArray(guids) ? guids : [guids])
    .map((g) => String(g || "").trim())
    .filter(Boolean);
  if (!ids.length) return;
  try {
    await redis().hdel(k("transcribe_pending"), ...ids);
  } catch (err) {
    console.error("Could not clear a pending transcription:", err);
  }
}
