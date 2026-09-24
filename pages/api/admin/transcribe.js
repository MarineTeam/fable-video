// Queues bunny.net Transcribe AI for one video, and ingests the result.
//
//   POST { guid }               -> queue transcription (COSTS MONEY, see below)
//   POST { guid, chapters }     -> ...and ask bunny for chapter suggestions
//   POST { guid, ingest }       -> pull the finished captions into Redis
//   POST { guid, suggestions }  -> read back the suggested chapters (writes
//                                  NOTHING — see lib/aiChapters.js)
//
// THIS ROUTE SPENDS MONEY. bunny bills transcription at $0.10 per minute of
// video, per language — a 90-minute service in three languages is $27 from one
// request. That is why it sits behind videos.manage (the same capability as
// deleting a video, because both are consequential and irreversible-ish) and a
// tighter rate limit than any other endpoint here: 10/hour versus the share
// endpoint's 30/hour, because share links are free and this is not.
//
// Transcription is ASYNCHRONOUS. Queueing returns immediately; the captions
// appear on bunny minutes later. There is no webhook wired up here, so the
// admin ingests when it is ready — an explicit second action rather than a
// background poller, which keeps the cost and the timing visible.
import { requireCapability } from "../../../lib/guard";
import { CAP } from "../../../lib/roles";
import { isExplicitlyTrue, oneTrimmed } from "../../../lib/params";
import { allowRequest } from "../../../lib/ratelimit";
import { fetchCaptionVtt, getVideo, transcribeVideo } from "../../../lib/bunny";
import { parseVtt } from "../../../lib/captions";
import { suggestedChapters } from "../../../lib/aiChapters";
import {
  clearTranscribePending,
  markTranscribePending,
  setTranscript,
} from "../../../lib/captionsStore";
import { logAction } from "../../../lib/audit";
import { withMonitorApi } from "../../../lib/monitor";

// bunny returns caption languages as ISO 639-1-ish shortcodes.
const LANG = /^[A-Za-z0-9-]{2,12}$/;

async function handler(req, res) {
  const admin = await requireCapability(req, res, CAP.VIDEOS_MANAGE);
  if (!admin) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const guid = oneTrimmed(req.body?.guid);
  if (!guid) return res.status(400).json({ error: "Video id is required" });

  // Ingest is the cheap half — it only reads a file bunny already produced,
  // so it is handled before the rate limit that guards the paid half.
  if (isExplicitlyTrue(req.body?.ingest)) {
    return ingest(req, res, admin, guid);
  }

  // Reading back suggestions is cheaper still: one GET, no write anywhere, so
  // it sits in front of the money limiter too.
  if (isExplicitlyTrue(req.body?.suggestions)) {
    return suggestions(res, guid);
  }

  if (!(await allowRequest("transcribe", admin, 10, "1 h"))) {
    return res.status(429).json({ error: "Too many transcription requests — try again shortly" });
  }

  // force=true re-runs transcription on a video that already has it, which is
  // a SECOND charge for the same minutes. It must be asked for in so many
  // words; a truthy value is not good enough for something that bills.
  const force = isExplicitlyTrue(req.body?.force);
  const sourceLanguage = oneTrimmed(req.body?.sourceLanguage);
  if (sourceLanguage && !LANG.test(sourceLanguage)) {
    return res.status(400).json({ error: "Bad source language" });
  }

  // Chapter suggestions ride along with the same job — no extra per-minute
  // charge — but they are opt-in all the same, because a video whose chapters
  // an admin has already typed has no use for a second opinion, and asking
  // keeps "what did this job produce" a question with an answer.
  const chapters = isExplicitlyTrue(req.body?.chapters);

  try {
    await transcribeVideo(guid, { sourceLanguage, force, generateChapters: chapters });
  } catch (err) {
    console.error("Could not queue transcription:", err);
    return res.status(502).json({ error: "Could not queue transcription" });
  }

  // Recorded so the admin video list can collect the result without a second
  // click. Best-effort AT THE CALL SITE as well as inside the store: the
  // money has already been spent by this line, so a bookkeeping failure must
  // not be reported as a failed transcription. The admin would re-click, and
  // pay twice for the same minutes.
  await markTranscribePending(guid).catch((err) => {
    console.error("Could not record a pending transcription:", err);
  });

  await logAction(
    admin,
    force ? "video.retranscribe" : "video.transcribe",
    chapters ? `${guid} (with chapter suggestions)` : guid
  );
  return res.json({ ok: true, queued: true, chapters });
}

// Reads bunny's generated chapters back as a proposal. READ-ONLY on purpose:
// this route never touches `fablevideo:chapters`, so a transcription job can
// never replace a list an admin typed. The admin accepts a proposal by loading
// it into the chapters textarea and saving it through `set-chapters`, which is
// the same path a hand-typed list takes.
//
// Not audit-logged: nothing changed. The acceptance is what gets logged, by
// set-chapters, exactly as if the admin had typed the lines.
async function suggestions(res, guid) {
  let video;
  try {
    video = await getVideo(guid);
  } catch (err) {
    if (err?.status === 404) return res.status(404).json({ error: "Video not found" });
    console.error("Could not read the video for chapter suggestions:", err);
    return res.status(502).json({ error: "Could not read the video" });
  }

  const { chapters, ignored } = suggestedChapters(video);
  return res.json({ ok: true, chapters, ignored });
}

// Pulls the finished captions off bunny's CDN and stores the parsed cues.
// Separate from queueing because transcription is asynchronous: at queue time
// there is nothing to fetch.
async function ingest(req, res, admin, guid) {
  let video;
  try {
    video = await getVideo(guid);
  } catch (err) {
    if (err?.status === 404) return res.status(404).json({ error: "Video not found" });
    console.error("Could not read the video before ingesting captions:", err);
    return res.status(502).json({ error: "Could not read the video" });
  }

  const languages = (video?.captions || [])
    .map((caption) => String(caption?.srclang || "").trim())
    .filter((lang) => LANG.test(lang));

  if (!languages.length) {
    // Not an error: transcription is probably still running.
    return res.json({ ok: true, ready: false, cues: 0 });
  }

  // One track is enough for the transcript panel. Prefer English when bunny
  // produced several, otherwise take the first — picking deterministically
  // beats whichever order the API happened to return.
  const chosen = languages.includes("en") ? "en" : languages[0];

  let vtt;
  try {
    vtt = await fetchCaptionVtt(guid, chosen);
  } catch (err) {
    console.error("Could not fetch a caption file:", err);
    return res.status(502).json({ error: "Could not fetch the captions" });
  }

  const cues = parseVtt(vtt);
  if (!cues.length) {
    // The file exists but parsed to nothing — report it rather than silently
    // storing an empty transcript that looks like "never transcribed".
    return res.json({ ok: true, ready: false, cues: 0, language: chosen });
  }

  try {
    await setTranscript(guid, cues);
  } catch (err) {
    console.error("Could not store a transcript:", err);
    return res.status(502).json({ error: "Could not store the transcript" });
  }

  // Collected, one way or another — nothing left to wait for. Guarded for the
  // same reason: the transcript is already stored by this line.
  await clearTranscribePending(guid).catch((err) => {
    console.error("Could not clear a pending transcription:", err);
  });

  await logAction(admin, "video.transcript_ingest", `${guid} (${chosen}, ${cues.length} cues)`);
  return res.json({ ok: true, ready: true, cues: cues.length, language: chosen });
}

export default withMonitorApi(handler);
