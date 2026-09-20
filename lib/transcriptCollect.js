// Collects transcriptions that bunny has finished, for videos an admin queued
// and has not fetched by hand.
//
// SERVER ONLY — this talks to bunny and Redis. The decisions about WHICH
// queued jobs to look at live in lib/transcribeQueue.js, which is pure; this
// module only does what that one decided.
//
// It runs on the admin video list, the same place the new-video push announce
// already rides, and it is best-effort end to end: an admin loading their own
// video list must never see an error because a transcript could not be
// collected. Whatever fails is simply tried again next time, until the job
// ages out.
import { fetchCaptionVtt, getVideo } from "./bunny";
import { parseVtt } from "./captions";
import {
  clearTranscribePending,
  getTranscribePending,
  setTranscript,
  setTranscriptLanguage,
  setTranscriptLanguages,
} from "./captionsStore";
import { planCollection } from "./transcribeQueue";

const LANG = /^[A-Za-z0-9-]{2,12}$/;

// One video: is it ready, and if so store EVERY track bunny produced.
//
// All of them, not one: translation is billed per language, so a portal that
// paid for Spanish and got only English back has paid for nothing. The default
// track — English when present, otherwise the first — goes in the main hash
// and is what a viewer sees before choosing.
//
// Returns the default language and its cue count, plus every language stored,
// or null when there is nothing to collect yet.
async function collectOne(guid) {
  const video = await getVideo(guid);
  const languages = (video?.captions || [])
    .map((caption) => String(caption?.srclang || "").trim().toLowerCase())
    .filter((lang) => LANG.test(lang));
  if (!languages.length) return null;

  const language = languages.includes("en") ? "en" : languages[0];
  const cues = parseVtt(await fetchCaptionVtt(guid, language));
  // Nothing is stored until the DEFAULT track parses. Storing translations
  // around an absent default would leave a video whose transcript panel has a
  // language picker and no transcript under it.
  if (!cues.length) return null;
  await setTranscript(guid, cues);

  const stored = [language];
  for (const code of languages) {
    if (code === language) continue;
    try {
      const extra = parseVtt(await fetchCaptionVtt(guid, code));
      if (!extra.length) continue;
      await setTranscriptLanguage(guid, code, extra);
      stored.push(code);
    } catch (err) {
      // One unreadable translation must not cost the others, or the default.
      console.error(`Could not collect the ${code} transcript for ${guid}:`, err);
    }
  }
  await setTranscriptLanguages(guid, language, stored);

  return { language, cues: cues.length, languages: stored };
}

// Returns { collected: [...], expired: [...] } — a summary for the caller to
// log, never a throw.
export async function collectFinishedTranscripts() {
  const pending = await getTranscribePending();
  if (!Object.keys(pending).length) return { collected: [], expired: [] };

  const { collect, expired } = planCollection(pending);
  // Dropped without another attempt: a job this old is not going to finish,
  // and retrying it costs two bunny calls on every admin page load forever.
  if (expired.length) await clearTranscribePending(expired);

  const collected = [];
  for (const guid of collect) {
    try {
      const result = await collectOne(guid);
      if (!result) continue; // still running — leave the marker for next time
      await clearTranscribePending(guid);
      collected.push({ guid, ...result });
    } catch (err) {
      // Left pending on purpose: a transient bunny failure should be retried,
      // and a permanent one ages out on its own.
      console.error(`Could not collect the transcript for ${guid}:`, err);
    }
  }
  return { collected, expired };
}
