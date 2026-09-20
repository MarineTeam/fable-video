// bunny.net Stream API client: video/collection CRUD, statistics, TUS upload
// signing, tokenized embed URLs, and CDN token-signed thumbnail URLs.
// Direct CDN file URLs are never used or exposed — playback always goes
// through a signed, time-limited embed token.
import crypto from "crypto";
import { recordExternal } from "./monitor";

const STREAM_API = "https://video.bunnycdn.com";

// Values are trimmed defensively: a stray newline in a pasted key corrupts
// TUS signatures and API calls.
const env = (name) => (process.env[name] || "").trim();

export const libraryId = () => env("BUNNY_LIBRARY_ID");
const apiKey = () => env("BUNNY_API_KEY");
const tokenAuthKey = () => env("BUNNY_TOKEN_AUTH_KEY");
const cdnHostname = () => env("BUNNY_CDN_HOSTNAME");
const cdnTokenKey = () => env("BUNNY_CDN_TOKEN_KEY") || tokenAuthKey();

// Query Monitor instrumentation: every bunny.net call funnels through this
// one helper, so timing it here covers every call site below with no
// per-call-site edits — none of the signing functions further down call
// `api()`, so they're untouched by this. recordExternal is a no-op outside
// a withMonitorApi/withMonitorPage context and when the monitor is off.
async function api(path, { method = "GET", body } = {}) {
  const start = process.hrtime.bigint();
  try {
    const res = await fetch(`${STREAM_API}/library/${libraryId()}${path}`, {
      method,
      headers: {
        AccessKey: apiKey(),
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const error = new Error(`bunny.net ${method} ${path} failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } finally {
    recordExternal(bunnyLabel(path), Number(process.hrtime.bigint() - start) / 1e6);
  }
}

// /videos?... -> "bunny /videos", /collections/<id> -> "bunny /collections",
// keeping ids and query strings out of the label.
function bunnyLabel(path) {
  const segment = String(path || "").split("?")[0].split("/").filter(Boolean)[0];
  return `bunny /${segment || "api"}`;
}

export async function listVideos({ page = 1, itemsPerPage = 100 } = {}) {
  const params = new URLSearchParams({
    page: String(page),
    itemsPerPage: String(itemsPerPage),
    orderBy: "date",
  });
  return api(`/videos?${params}`);
}

const VIDEO_LIST_CACHE_TTL_MS = 4000;
let videoListCache = null; // { at, promise }

function invalidateVideoListCache() {
  videoListCache = null;
}

// The first page tells us the total count, so any remaining pages are
// fetched in parallel instead of one page at a time.
async function fetchAllVideosUncached({ maxPages }) {
  const first = await listVideos({ page: 1 });
  const items = first?.items || [];
  const total = first?.totalItems ?? items.length;
  if (!items.length || items.length >= total) return items;

  const totalPages = Math.min(maxPages, Math.ceil(total / items.length));
  if (totalPages <= 1) return items;

  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) => listVideos({ page: i + 2 }))
  );
  const videos = [...items];
  for (const data of rest) videos.push(...(data?.items || []));
  return videos;
}

// Cached briefly per warm serverless instance — the homepage, search,
// filters, and pagination all call this, and without a cache every
// interaction re-fetches the whole library from bunny.net. Any mutation
// below invalidates it immediately so admin changes show up right away.
export function listAllVideos({ maxPages = 5 } = {}) {
  const now = Date.now();
  if (videoListCache && now - videoListCache.at < VIDEO_LIST_CACHE_TTL_MS) {
    return videoListCache.promise;
  }
  const promise = fetchAllVideosUncached({ maxPages });
  videoListCache = { at: now, promise };
  promise.catch(() => {
    if (videoListCache?.promise === promise) videoListCache = null;
  });
  return promise;
}

export const getVideo = (id) => api(`/videos/${encodeURIComponent(id)}`);

export async function createVideo(title, collectionId) {
  const video = await api("/videos", {
    method: "POST",
    body: { title, ...(collectionId ? { collectionId } : {}) },
  });
  invalidateVideoListCache();
  return video;
}

export async function updateVideo(id, patch) {
  const result = await api(`/videos/${encodeURIComponent(id)}`, {
    method: "POST",
    body: patch,
  });
  invalidateVideoListCache();
  return result;
}

export async function deleteVideo(id) {
  const result = await api(`/videos/${encodeURIComponent(id)}`, { method: "DELETE" });
  invalidateVideoListCache();
  return result;
}

export async function listCollections() {
  const data = await api(`/collections?page=1&itemsPerPage=100&orderBy=date`);
  return data?.items || [];
}

export const createCollection = (name) =>
  api("/collections", { method: "POST", body: { name } });

export const deleteCollection = (id) =>
  api(`/collections/${encodeURIComponent(id)}`, { method: "DELETE" });

export function getStatistics({ dateFrom, dateTo } = {}) {
  const params = new URLSearchParams();
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  const qs = params.toString();
  return api(`/statistics${qs ? `?${qs}` : ""}`);
}

// bunny.net video status codes: 0 created, 1 uploaded, 2 processing,
// 3 transcoding, 4 finished, 5 error, 6 upload failed (7+ = JIT states,
// already playable).
export function videoState(video) {
  const status = Number(video?.status);
  if (status === 5 || status === 6) return "failed";
  if (status === 4 || status > 6) return "ready";
  return "processing";
}

// Signed, time-limited embed URL — generated fresh per request, never stored.
// token = SHA256_hex(embedTokenKey + videoId + expires)
export function signEmbedUrl(videoId, { ttlSeconds = 3 * 3600 } = {}) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = crypto
    .createHash("sha256")
    .update(`${tokenAuthKey()}${videoId}${expires}`)
    .digest("hex");
  return `https://iframe.mediadelivery.net/embed/${libraryId()}/${videoId}?token=${token}&expires=${expires}&autoplay=false`;
}

// TUS resumable upload auth for direct browser -> bunny.net uploads.
// signature = SHA256_hex(libraryId + apiKey + expire + videoId)
export function signTusUpload(videoId, { ttlSeconds = 6 * 3600 } = {}) {
  const expire = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = crypto
    .createHash("sha256")
    .update(`${libraryId()}${apiKey()}${expire}${videoId}`)
    .digest("hex");
  return {
    endpoint: `${STREAM_API}/tusupload`,
    signature,
    expire,
    videoId,
    libraryId: libraryId(),
  };
}

export function thumbnailsEnabled() {
  return Boolean(cdnHostname());
}

// CDN thumbnail URL, token-signed (base64url SHA256 of key + path + expires)
// so thumbnails keep working with "Block Direct URL File Access" enabled.
export function thumbnailUrl(video) {
  const host = cdnHostname();
  if (!host || !video?.guid) return null;
  const file = video.thumbnailFileName || "thumbnail.jpg";
  const path = `/${video.guid}/${file}`;
  const key = cdnTokenKey();
  if (!key) return `https://${host}${path}`;
  const expires = Math.floor(Date.now() / 1000) + 6 * 3600;
  const token = crypto
    .createHash("sha256")
    .update(`${key}${path}${expires}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `https://${host}${path}?token=${token}&expires=${expires}`;
}

// Queues transcription with bunny's Transcribe AI (Whisper). ASYNCHRONOUS —
// this returns as soon as the job is queued, not when captions exist.
//
// THIS CALL COSTS MONEY: $0.10 per minute of video, per language. A 90-minute
// service in three languages is $27 from one POST, which is why the route in
// front of it is rate-limited and capability-gated.
//
// Everything bunny can generate BESIDES captions is explicitly off:
//
//   generateTitle/generateDescription — titles here are admin-authored. A
//     transcription job must never rename someone's library.
//   generateMoments                   — off for the same reason as titles:
//     nothing here reads moments, so generating them is output with no reader.
//
// `generateChapters` is the ONE exception, and it is opt-in. It writes to
// bunny's own video object, never to `fablevideo:chapters` — the hand-typed
// list this repo renders is untouched by a transcription job whatever this
// flag says. The suggestions are read back by lib/aiChapters.js and land in
// the admin's textarea, where a person accepts them through the ordinary
// set-chapters path. That is the "explicit accept action" this comment used to
// describe as unbuilt.
//
// `force` re-runs transcription on a video that already has it — a second
// charge for the same minutes. It defaults to false and the caller must opt in.
export async function transcribeVideo(
  id,
  { sourceLanguage, targetLanguages = [], force = false, generateChapters = false } = {}
) {
  const query = force ? "?force=true" : "";
  const result = await api(`/videos/${encodeURIComponent(id)}/transcribe${query}`, {
    method: "POST",
    body: {
      ...(sourceLanguage ? { sourceLanguage } : {}),
      ...(targetLanguages.length ? { targetLanguages } : {}),
      generateTitle: false,
      generateDescription: false,
      generateChapters: Boolean(generateChapters),
      generateMoments: false,
    },
  });
  // Transcription rewrites the video's captions, so the cached list is stale.
  invalidateVideoListCache();
  return result;
}

// Fetches one caption track's WebVTT text, SERVER-SIDE ONLY.
//
// Caption files live on the pull zone at /{guid}/captions/{srclang}.vtt, which
// is a direct CDN file URL. The fence in this repo is that only signEmbedUrl()
// and thumbnailUrl() outputs may ever reach a browser, and a captions URL is
// neither — so this function returns the VTT *text*, never the URL, and no
// caller is given a way to obtain the URL itself. The transcript then inherits
// the video's access gate instead of being readable by anyone who learns a
// GUID, which matters because a transcript is the whole content of a private
// video in text form.
export async function fetchCaptionVtt(guid, srclang) {
  const host = cdnHostname();
  const id = String(guid || "").trim();
  const lang = String(srclang || "").trim();
  // Path traversal would turn this into an arbitrary pull-zone fetch.
  if (!host || !/^[A-Za-z0-9-]+$/.test(id) || !/^[A-Za-z0-9-]{2,12}$/.test(lang)) {
    return null;
  }

  const path = `/${id}/captions/${lang}.vtt`;
  const key = cdnTokenKey();
  let url = `https://${host}${path}`;
  if (key) {
    const expires = Math.floor(Date.now() / 1000) + 300;
    const token = crypto
      .createHash("sha256")
      .update(`${key}${path}${expires}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    url = `${url}?token=${token}&expires=${expires}`;
  }

  const res = await fetch(url);
  // A 404 is the ordinary "not transcribed yet" answer, not a failure.
  if (!res.ok) return null;
  return res.text();
}
