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
import { randomUUID } from "node:crypto";
import { k, redis } from "./redis";
import { MAX_CUES, isLanguageCode, normalizeLanguages, transcriptText } from "./captions";
import { MIN_TRANSCRIPT_QUERY, normalizeSpoken } from "./search";

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
// `${videoId}:${lang}` -> that TRANSLATION's words, already normalised
// (normalizeSpoken), for library search in every language. See
// matchingTranslatedIds below for why this one is searched inside Redis.
const altTextKey = () => k("transcript_text_alt");

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
// This is the DEFAULT track, whose text the search route loads and matches in
// JavaScript. Additional languages go through setTranscriptLanguage, which
// writes their text to a separate hash searched inside Redis instead.
export async function setTranscript(id, cues) {
  const key = videoId(id);
  if (!key) return;
  const list = Array.isArray(cues) ? cues.slice(0, MAX_CUES) : [];
  if (!list.length) return clearTranscript(key);
  await redis().hset(cuesKey(), { [key]: JSON.stringify(list) });
  await redis().hset(textKey(), { [key]: transcriptText(list) });
}

// One additional language: its cues for the transcript panel, and its words
// for library search. The words go to their own hash (not the default text
// hash the search route loads), already normalised, because that hash is
// searched INSIDE Redis — see matchingTranslatedIds.
export async function setTranscriptLanguage(id, lang, cues) {
  const key = videoId(id);
  const code = String(lang || "").trim().toLowerCase();
  if (!key || !isLanguageCode(code)) return;
  const list = Array.isArray(cues) ? cues.slice(0, MAX_CUES) : [];
  if (!list.length) return;
  const field = `${key}:${code}`;
  await redis().hset(altKey(), { [field]: JSON.stringify(list) });
  await redis().hset(altTextKey(), { [field]: normalizeSpoken(transcriptText(list)) });
}

// Which videos said this in a TRANSLATION — ids only.
//
// Search in every language without multiplying what every search loads. The
// default track's text is loaded into the route and matched there, as it
// always was; loading every translation the same way would multiply that read
// by the number of languages, to return the same videos. So translations are
// matched where they already are: a short script walks the translation hash
// inside Redis and hands back only the ids of the videos whose words contain
// the query. What crosses the network is a list of ids.
//
// The stored words and the query are normalised by the SAME function
// (normalizeSpoken, in JavaScript, so it is Unicode-aware), which leaves the
// script a plain byte-for-byte substring test — exactly what the default track
// gets from includes() in lib/search.js.
//
// The ids are a hint, never an answer: lib/search.js only uses them to mark
// videos IN the viewer's already-authorised list, so an id for a video they
// cannot see matches nothing.
const TRANSLATED_MATCH_SCRIPT = `
local fields = redis.call("HGETALL", KEYS[1])
local needle = ARGV[1]
local seen = {}
local out = {}
for i = 1, #fields, 2 do
  local id = string.match(fields[i], "^(.+):[^:]+$")
  if id and not seen[id] and string.find(fields[i + 1], needle, 1, true) then
    seen[id] = true
    out[#out + 1] = id
  end
end
return out
`;

export async function matchingTranslatedIds(query) {
  const needle = normalizeSpoken(query);
  if (needle.length < MIN_TRANSCRIPT_QUERY) return new Set();
  const ids = await redis().eval(TRANSLATED_MATCH_SCRIPT, [altTextKey()], [needle]);
  // String(): the client parses an all-digit id into a number.
  return new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)));
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
    const fields = all.map((code) => `${key}:${code}`);
    await redis().hdel(altKey(), ...fields);
    await redis().hdel(altTextKey(), ...fields);
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

// --- One collector at a time ------------------------------------------------
//
//   k("transcribe_collecting")  random token, expires after five minutes
//
// Collection can start from two places at once — an admin loading the video
// list while the scheduled job runs, or the scheduler delivering one run twice
// (Vercel says it can). Both would fetch the same captions from bunny and log
// the same "collected" line twice. The lock makes the second one skip; the
// work it skipped is still pending and is picked up next time.
//
// The token is compared on release, so a run that outlived its lock can never
// delete a lock a newer run now holds. A lock that cannot be taken or read is
// treated as held: skipping is always safe here, and collecting twice is the
// thing being prevented.
const COLLECT_LOCK_SECONDS = 5 * 60;
const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export async function acquireCollectLock() {
  const token = `lock-${randomUUID()}`;
  try {
    const ok = await redis().set(k("transcribe_collecting"), token, { nx: true, ex: COLLECT_LOCK_SECONDS });
    return ok === "OK" ? token : null;
  } catch (err) {
    console.error("Could not take the transcript collection lock:", err);
    return null;
  }
}

export async function releaseCollectLock(token) {
  if (!token) return;
  try {
    await redis().eval(RELEASE_LOCK_SCRIPT, [k("transcribe_collecting")], [token]);
  } catch (err) {
    // It expires on its own; the next run waits at most five minutes.
    console.error("Could not release the transcript collection lock:", err);
  }
}
