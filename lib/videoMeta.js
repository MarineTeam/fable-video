// Storage for the two additive per-video text features: chapters and sermon
// notes. The parsing/formatting lives in the pure modules (lib/chapters.js,
// lib/notes.js) so the watch page and homepage can import it without pulling
// Redis — and therefore Node built-ins — into the browser bundle.
//
// Both live in one hash each (k("chapters"), k("notes")), video id -> value,
// so reading the whole library's worth costs one Redis command apiece — the
// same shape as lib/schedule.js.
//
// ADDITIVE BY DEFAULT: no row means no chapters and no notes, and the video
// behaves exactly as it did before this existed. Nothing here decides who may
// see a video; it only decorates one they can already reach.
import { k, redis } from "./redis";
import { MAX_CHAPTERS, normalizeChapters } from "./chapters";
import { cleanNotes } from "./notes";

const chaptersKey = () => k("chapters");
const notesKey = () => k("notes");

function videoId(id) {
  return String(id || "").trim();
}

export async function getChapters(id) {
  const key = videoId(id);
  if (!key) return [];
  const raw = await redis().hget(chaptersKey(), key);
  return normalizeChapters(raw);
}

export async function getChaptersMap() {
  const raw = (await redis().hgetall(chaptersKey())) || {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    const chapters = normalizeChapters(value);
    if (chapters.length) out[id] = chapters;
  }
  return out;
}

// An empty list deletes the row: "no chapters" is the absence of a record,
// never a stored empty array, so the hash only ever describes videos that
// actually have chapters.
export async function setChapters(id, chapters) {
  const key = videoId(id);
  if (!key) return [];
  const normalized = normalizeChapters(chapters).slice(0, MAX_CHAPTERS);
  if (!normalized.length) {
    await redis().hdel(chaptersKey(), key);
    return [];
  }
  await redis().hset(chaptersKey(), { [key]: normalized });
  return normalized;
}

export async function clearChapters(id) {
  const key = videoId(id);
  if (!key) return;
  await redis().hdel(chaptersKey(), key);
}

export async function getNotes(id) {
  const key = videoId(id);
  if (!key) return null;
  const raw = await redis().hget(notesKey(), key);
  return cleanNotes(raw);
}

export async function getNotesMap() {
  const raw = (await redis().hgetall(notesKey())) || {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    const notes = cleanNotes(value);
    if (notes) out[id] = notes;
  }
  return out;
}

// Same rule as setChapters: empty deletes.
export async function setNotes(id, value) {
  const key = videoId(id);
  if (!key) return null;
  const notes = cleanNotes(value);
  if (!notes) {
    await redis().hdel(notesKey(), key);
    return null;
  }
  await redis().hset(notesKey(), { [key]: notes });
  return notes;
}

export async function clearNotes(id) {
  const key = videoId(id);
  if (!key) return;
  await redis().hdel(notesKey(), key);
}

// Called when a video is deleted, alongside the order/group/schedule prunes,
// so a recycled id never inherits the previous video's chapters or notes.
export async function pruneVideoMeta(id) {
  const key = videoId(id);
  if (!key) return;
  const r = redis();
  await Promise.all([
    r.hdel(chaptersKey(), key).catch(() => {}),
    r.hdel(notesKey(), key).catch(() => {}),
  ]);
}
