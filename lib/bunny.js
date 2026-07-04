// bunny.net Stream API client: video/collection CRUD, statistics, TUS upload
// signing, tokenized embed URLs, and CDN token-signed thumbnail URLs.
// Direct CDN file URLs are never used or exposed — playback always goes
// through a signed, time-limited embed token.
import crypto from "crypto";

const STREAM_API = "https://video.bunnycdn.com";

// Values are trimmed defensively: a stray newline in a pasted key corrupts
// TUS signatures and API calls.
const env = (name) => (process.env[name] || "").trim();

export const libraryId = () => env("BUNNY_LIBRARY_ID");
const apiKey = () => env("BUNNY_API_KEY");
const tokenAuthKey = () => env("BUNNY_TOKEN_AUTH_KEY");
const cdnHostname = () => env("BUNNY_CDN_HOSTNAME");
const cdnTokenKey = () => env("BUNNY_CDN_TOKEN_KEY") || tokenAuthKey();

async function api(path, { method = "GET", body } = {}) {
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
}

export async function listVideos({ page = 1, itemsPerPage = 100 } = {}) {
  const params = new URLSearchParams({
    page: String(page),
    itemsPerPage: String(itemsPerPage),
    orderBy: "date",
  });
  return api(`/videos?${params}`);
}

export async function listAllVideos({ maxPages = 5 } = {}) {
  const videos = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await listVideos({ page });
    const items = data?.items || [];
    videos.push(...items);
    if (!items.length || videos.length >= (data?.totalItems || 0)) break;
  }
  return videos;
}

export const getVideo = (id) => api(`/videos/${encodeURIComponent(id)}`);

export const createVideo = (title, collectionId) =>
  api("/videos", {
    method: "POST",
    body: { title, ...(collectionId ? { collectionId } : {}) },
  });

export const updateVideo = (id, patch) =>
  api(`/videos/${encodeURIComponent(id)}`, { method: "POST", body: patch });

export const deleteVideo = (id) =>
  api(`/videos/${encodeURIComponent(id)}`, { method: "DELETE" });

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
  return `https://iframe.mediadelivery.net/embed/${libraryId()}/${videoId}?token=${token}&expires=${expires}&autoplay=false&preload=true`;
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
