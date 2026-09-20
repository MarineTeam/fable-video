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
} from "./captionsStore";
import { planCollection } from "./transcribeQueue";

const LANG = /^[A-Za-z0-9-]{2,12}$/;

// One video: is it ready, and if so store it. Returns the language and cue
// count on success, or null when there is nothing to collect yet.
async function collectOne(guid) {
  const video = await getVideo(guid);
  const languages = (video?.captions || [])
    .map((caption) => String(caption?.srclang || "").trim())
    .filter((lang) => LANG.test(lang));
  if (!languages.length) return null;

  // Same deterministic choice the manual ingest makes: English when bunny
  // produced several, otherwise the first. Collecting a different track than
  // the button would have is a surprise nobody needs.
  const language = languages.includes("en") ? "en" : languages[0];
  const cues = parseVtt(await fetchCaptionVtt(guid, language));
  if (!cues.length) return null;

  await setTranscript(guid, cues);
  return { language, cues: cues.length };
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
