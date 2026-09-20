// Chapters / timestamps for a single video.
//
// A 60-90 minute service recording is unusable without a way in: this turns
// "Worship 0:00 · Announcements 18:30 · Sermon 24:15" into seek targets.
//
// PURE MODULE — no Redis import, deliberately. The watch page renders the
// chapter list in the browser, so anything it imports ends up in the client
// bundle; pulling lib/redis.js in here would drag Node built-ins (async_hooks,
// via lib/monitor.js) into that bundle and fail the build. Storage lives in
// lib/videoMeta.js. Same split as lib/capabilities.js vs lib/roles.js and
// lib/siteName.js vs lib/store.js.

export const MAX_CHAPTERS = 100;
export const MAX_LABEL_LENGTH = 100;

// One chapter per line: a timestamp, then the title.
//   0:00 Worship
//   18:30 - Announcements
//   1:11:00 — Communion
// Accepted timestamps are M:SS, MM:SS and H:MM:SS (and HH:MM:SS). Seconds and
// the minutes field of an H:MM:SS stamp are two digits below 60 — "5:99" is a
// typo, not 99 seconds, and guessing what the admin meant is worse than
// telling them the line was skipped.
const LINE = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\s*[-–—·|:]?\s*(.*)$/;

// Strips control characters (including anything pasted out of a word
// processor) while leaving ordinary punctuation and non-Latin text intact.
const CONTROL = /\p{Cc}|\p{Cf}/gu;

// Exported because lib/aiChapters.js sanitizes bunny's suggested titles with
// it: a label reaching the textarea should be scrubbed identically whether an
// admin typed it or a transcription job produced it.
export function cleanLabel(value) {
  return String(value || "")
    .replace(CONTROL, " ")
    .trim();
}

export function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Parses an admin's textarea into { chapters, ignored }.
//
// `ignored` carries the 1-based line number and the original text of every
// line that could not be read, so the admin is TOLD what was dropped rather
// than discovering it missing later. Blank lines are not "ignored" — they are
// whitespace and carry no intent.
//
// Chapters come back sorted by timestamp regardless of the order they were
// typed in: the admin should be able to append a chapter they forgot without
// having to re-sort the list by hand.
export function parseChapters(text) {
  const chapters = [];
  const ignored = [];
  const lines = String(text || "").split(/\r?\n/);

  lines.forEach((raw, index) => {
    const line = cleanLabel(raw);
    if (!line) return;
    const lineNumber = index + 1;

    if (chapters.length >= MAX_CHAPTERS) {
      ignored.push({
        line: lineNumber,
        text: line,
        reason: `over the ${MAX_CHAPTERS}-chapter limit`,
      });
      return;
    }

    const match = LINE.exec(line);
    if (!match) {
      ignored.push({
        line: lineNumber,
        text: line,
        reason: "no timestamp at the start of the line",
      });
      return;
    }

    const [, a, b, c, rest] = match;
    // Two fields is M:SS; three is H:MM:SS.
    const t =
      c === undefined
        ? Number(a) * 60 + Number(b)
        : Number(a) * 3600 + Number(b) * 60 + Number(c);

    const label = cleanLabel(rest).slice(0, MAX_LABEL_LENGTH);
    if (!label) {
      ignored.push({
        line: lineNumber,
        text: line,
        reason: "no title after the timestamp",
      });
      return;
    }

    chapters.push({ t, label });
  });

  // Stable sort: two chapters on the same second keep the typed order.
  chapters.sort((x, y) => x.t - y.t);
  return { chapters, ignored };
}

// Renders chapters back into the textarea format, so editing an existing list
// shows the same shape the parser accepts.
export function formatChapters(chapters) {
  return (Array.isArray(chapters) ? chapters : [])
    .map((c) => `${formatTimestamp(c.t)} ${c.label}`)
    .join("\n");
}

// Chapters that start at or past the end of the recording. Not an error and
// never rejected — a video can be re-encoded to a different length, and a
// stamp a few seconds over is harmless — but worth warning the admin about,
// since it usually means a mistyped hour field.
export function beyondDuration(chapters, duration) {
  const end = Number(duration) || 0;
  if (end <= 0) return [];
  return (Array.isArray(chapters) ? chapters : []).filter((c) => c.t >= end);
}

// Normalizes whatever came back from storage into the render shape, dropping
// anything malformed. A bad stored record must degrade to "no chapters",
// never to a broken watch page.
export function normalizeChapters(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    const t = Number(entry?.t);
    const label = cleanLabel(entry?.label).slice(0, MAX_LABEL_LENGTH);
    if (!Number.isFinite(t) || t < 0 || !label) continue;
    out.push({ t: Math.floor(t), label });
    if (out.length >= MAX_CHAPTERS) break;
  }
  return out.sort((x, y) => x.t - y.t);
}
