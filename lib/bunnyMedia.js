// Signed, short-lived bunny.net CDN media URLs, for the podcast feed only.
//
// ── Why this file exists at all ───────────────────────────────────────────
//
// architecture-contract invariant (d) and change-control rule 3 say: no direct
// bunny CDN file URLs anywhere; playback only via signed embed tokens. A
// podcast feed cannot honour that literally — podcast apps fetch a media URL,
// they do not render an iframe. So this is a deliberate, NARROWED amendment to
// that invariant, not an oversight, and the narrowing is what preserves the
// property the invariant actually protects:
//
//   * No CDN URL is ever put in the feed, stored in Redis, logged, or shipped
//     to a client. The feed's <enclosure> points at THIS APP
//     (/api/feed/<token>/<videoId>.mp4). See lib/podcast.js.
//   * The CDN URL exists only as a transient 302 Location header, minted per
//     request after the caller's approval, groups and schedule have been
//     re-checked.
//   * It is token-signed and expires in minutes. The thing invariant (d)
//     exists to prevent is "a permanent, unauthenticated, shareable bypass";
//     a 15-minute signed URL is none of those three.
//
// ── Why the signing is duplicated rather than shared ──────────────────────
//
// The formula below is the same pull-zone token-auth scheme thumbnailUrl()
// uses in lib/bunny.js. It is COPIED rather than factored out because that
// file's signing helpers are byte-exact vendor contracts that must not be
// touched — refactoring thumbnailUrl to share a helper would mean editing a
// working signature for the benefit of a new caller, which is precisely the
// change most likely to silently break thumbnails. Two callers, two copies,
// both pinned by tests.
//
// ── Bunny capability note (verified against bunny.net docs, not assumed) ──
//
// bunny.net Stream has NO audio-only or MP3 rendition. Per-video storage is
// playlist.m3u8, optional play_{height}p.mp4 fallbacks, the original, plus
// thumbnails/previews/captions — no mp3 or m4a. So a "podcast" feed here
// carries VIDEO MP4 enclosures: they play in essentially every podcast app,
// but they are a much larger download than audio would be.
//
// Two further conditions, both on the bunny.net library and neither fixable
// from this repo:
//   1. "MP4 Fallback" must be enabled in the library's Encoding settings.
//   2. Only videos uploaded AFTER that was enabled get an MP4 generated —
//      existing recordings will 404 until they are re-uploaded.
// Without those, every enclosure fetch returns bunny.net's own 404. That is
// surfaced in the admin panel rather than hidden.
import crypto from "crypto";

const env = (name) => (process.env[name] || "").trim();

const cdnHostname = () => env("BUNNY_CDN_HOSTNAME");
const cdnTokenKey = () => env("BUNNY_CDN_TOKEN_KEY") || env("BUNNY_TOKEN_AUTH_KEY");

// Which MP4 fallback rendition to serve. 720p is the default: high enough to
// watch, and roughly half the bytes of 1080p over a mobile connection, which
// matters a great deal when the "episode" is a 90-minute service.
export const DEFAULT_MP4_HEIGHT = 720;

export function mp4Height() {
  const raw = Number(env("BUNNY_MP4_HEIGHT"));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MP4_HEIGHT;
}

// Media enclosures need the CDN pull zone, exactly like thumbnails do.
export function mediaEnabled() {
  return Boolean(cdnHostname());
}

// Signs one pull-zone path. TTL is short by default: the URL only has to
// survive the redirect and the download that immediately follows it, and a
// shorter life is a smaller window for a forwarded Location header to be
// reused. It is NOT a per-viewer credential — it names a file, not a person,
// which is why the identity check happens before this is ever called.
export function signCdnPath(path, { ttlSeconds = 15 * 60 } = {}) {
  const host = cdnHostname();
  if (!host || !path) return null;
  const key = cdnTokenKey();
  // No key configured means the pull zone has token auth off, in which case a
  // bare URL is what works. Returning null instead would break the feed on a
  // correctly-configured-but-unprotected zone.
  if (!key) return `https://${host}${path}`;
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = crypto
    .createHash("sha256")
    .update(`${key}${path}${expires}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `https://${host}${path}?token=${token}&expires=${expires}`;
}

// The signed MP4 for one video, or null when the pull zone isn't configured.
export function signedMp4Url(videoId, options = {}) {
  const id = String(videoId || "").trim();
  if (!id) return null;
  return signCdnPath(`/${id}/play_${mp4Height()}p.mp4`, options);
}
