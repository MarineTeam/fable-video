---
name: domain-reference
description: Third-party domain knowledge for the Marine Video Portal — how Auth0 v4, bunny.net Stream, Upstash Redis, Resend, TUS uploads, and player.js actually behave IN THIS REPO (not generic docs). Load when reading or writing code that touches login/session, video upload/playback/tokens, collections, Redis keys, share-link email, or resume progress, and you need to know what a service call does, what a status code means, what a key holds, or why a signature formula is shaped the way it is. Trigger phrases: "what is X", "how does Y work here", embed token, TUS, pull zone, CDN hostname, collection, GUID, rolling session, sliding window, TTL, Resend, player.js.
---

# Domain reference — Marine Video Portal

This file is the third-party knowledge a mid-level engineer would have to
relearn from scratch: what Auth0 v4, bunny.net Stream, Upstash Redis, Resend,
TUS, and player.js actually do **in this codebase**, not in general. It is
not a tutorial on any of these products — it only documents the slice this
app uses and exactly where.

Verified against the repository at v1.6.0 (2026-07-07), re-verified
2026-07-10. Everything below was read directly from the cited files, not
inferred. Line numbers are not cited because they drift; function/file names
are cited instead — grep for them if you need the exact line.

## When NOT to use this skill

| You are trying to... | Use instead |
|---|---|
| Decide whether a change is allowed, which gates to run, PR flow | `change-control` |
| Understand system-wide invariants (why the architecture is shaped this way) | `architecture-contract` |
| Respond to a CodeQL alert or suspected vulnerability (e.g. "why is SHA256 signing flagged as password hashing") | `security-response` |
| Bump a dependency, fix an install/peer-dependency failure | `dependency-currency` |
| Debug a runtime failure (500s, login loops, blank pages) | `debugging-playbook` |
| Understand a past incident or why a commit exists (e.g. the `pvp:` → `fablevideo:` key rename) | `failure-archaeology` |
| Add/change environment variables or config files | `environment-and-config` |
| Deploy, redeploy, or operate the running app | `run-and-operate` |
| Write or extend tests | `validation-and-qa` |
| Set up local tooling or diagnostics | `diagnostics-and-tooling` |
| Write README/CHANGELOG/docs prose | `docs-and-writing` |
| Plan and ship a whole feature end to end | `feature-shipping-campaign` |

Use **this** skill only for "how does the third-party service actually
behave here" questions — signature formulas, status codes, key shapes,
route maps, payload shapes.

---

## 1. Glossary

Definitions as they apply in this app. If a term has a generic meaning
elsewhere, this is the meaning that matters here.

| Term | Meaning here |
|---|---|
| **Embed token** | A short-lived hex string bunny.net requires as a query param (`?token=...&expires=...`) to play a video through `iframe.mediadelivery.net/embed/...`. Generated fresh per page load by `signEmbedUrl()` in `lib/bunny.js`. Never stored — recomputed on every `getServerSideProps` call. |
| **Pull zone** | bunny.net's CDN layer that serves files (thumbnails here) from a hostname like `vz-xxxx-xxx.b-cdn.net`. Configured via `BUNNY_CDN_HOSTNAME`. The app never uses a pull zone for video playback (only the tokenized embed iframe), only for thumbnail images. |
| **CDN hostname** | The pull zone's public hostname (`BUNNY_CDN_HOSTNAME`). Thumbnails are built as `https://{cdnHostname}/{guid}/{thumbnailFileName}`. Without it set, `thumbnailsEnabled()` returns false and the homepage falls back to a plain title list. |
| **Collection** | A bunny.net Stream grouping of videos (their own object with an `id`, not a Redis concept). Created/listed/deleted via `/collections` endpoints in `lib/bunny.js`; a video's `collectionId` field is set via `updateVideo`. Used for the homepage collection-filter chips. |
| **GUID** | bunny.net's video ID field, literally named `guid` in every API response. The app calls it `video.guid` internally but exposes it to viewers as `videoId` / `id`. This is the primary key used in Redis progress keys, order arrays, and share records. |
| **TUS** | An open resumable-upload HTTP protocol. Here it means: the admin's browser uploads a video file directly to `https://video.bunnycdn.com/tusupload` via the `tus-js-client` npm package, bypassing this app's own server entirely (no file bytes ever pass through Vercel). |
| **Rolling session** | An Auth0 session whose expiry is pushed forward on every request that hits the SDK's middleware, instead of expiring at a fixed time after login. Requires `proxy.js`'s matcher to run on (almost) every route — see section 2. |
| **Sliding window** | The rate-limiting algorithm from `@upstash/ratelimit` (`Ratelimit.slidingWindow(tokens, window)`) used for every limiter in this app — see section 7. Distinct from a fixed window: it smooths out the "burst right at the window boundary" problem. |
| **TTL** | Time-to-live, i.e. Redis key expiry in seconds, set via the `ex` option on `redis().set(key, val, { ex: seconds })`. Used for share links (`lib/shares.js`) and rate-limit counters. Most other keys (settings, viewers, order, progress, theme, audit) have **no TTL** — they persist until explicitly overwritten or deleted. |
| **Serverless instance** | A Vercel function invocation. `lib/bunny.js`'s `listAllVideos()` cache (`VIDEO_LIST_CACHE_TTL_MS = 4000`) is an in-memory module-level variable, so it only helps within one warm instance — a cold start or a different concurrent instance gets no benefit from it. |
| **SSR / `getServerSideProps`** | Pages Router's per-request server render. Used on `pages/index.js`, `pages/admin.js`, `pages/watch/video/[id].js`, `pages/watch/[shareId].js` — all four do the Auth0 session check and access-control redirect **server-side**, before any HTML reaches the browser. |
| **Hydration** | React attaching event handlers to server-rendered HTML in the browser. Relevant because `pages/index.js` deliberately fetches the video library in `getServerSideProps` (comment: "otherwise the client waits for hydration, then a whole extra fetch/bunny.net round trip") rather than fetching client-side after mount. |
| **Web Push** | The browser standard for delivering server-initiated notifications to a subscribed browser even when the site isn't open. Here: `lib/push.js` + the `web-push` npm package send them, `public/sw.js`'s `push`/`notificationclick` handlers display and route them, `components/PushToggle.js` subscribes/unsubscribes. Inert unless VAPID keys are set (see section 8). |
| **VAPID** | "Voluntary Application Server Identification" — the keypair that authenticates *this* server to the browser's push service. The **public** key (`NEXT_PUBLIC_VAPID_PUBLIC_KEY`) is the `applicationServerKey` the browser subscribes with and is not secret; the **private** key (`VAPID_PRIVATE_KEY`) signs each send and is a secret. Generated together with `npx web-push generate-vapid-keys`. |
| **Service worker** | The background script `public/sw.js`, registered by `pages/_app.js`. It makes the app an installable PWA, caches a fixed allowlist of static icons for offline load, and hosts the Web Push `push`/`notificationclick` handlers. It deliberately never caches Auth0, `/api/*`, or signed video/thumbnail responses (see `architecture-contract` invariant (k)). |
| **PWA / installable** | Progressive Web App: with a linked web manifest (`public/manifest.webmanifest`, linked in `pages/_document.js`) plus a registered service worker, the browser offers to install the portal to the home screen and launch it standalone. Note: **iOS/iPadOS only delivers Web Push to the installed PWA** (16.4+), not to Safari tabs — see section 8. |

---

## 2. Auth0 v4 as used here

### The client object

`lib/auth0.js` is the entire Auth0 wiring:

```js
import { Auth0Client } from "@auth0/nextjs-auth0/server";
export const auth0 = new Auth0Client();
```

Zero-config constructor — it reads `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`,
`AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`, and `APP_BASE_URL` from
`process.env` implicitly. There is no options object anywhere in this repo;
if you need to pass an explicit option (e.g. a custom session duration),
you're changing this constructor call, which makes the change
security-touching per `change-control`.

### Route map

Auth routes are **mounted**, not defined as page files — they don't exist
under `pages/api/auth/*` or `pages/auth/*`. `proxy.js` calls
`auth0.middleware(request)`, and the SDK internally handles these paths:

| Route | Purpose |
|---|---|
| `/auth/login` | Starts the Auth0 Universal Login redirect. Called with a `?returnTo=` query param everywhere the app redirects an unauthenticated visitor (see `pages/index.js`, `pages/watch/[shareId].js`, `pages/watch/video/[id].js`: `` `/auth/login?returnTo=${encodeURIComponent(resolvedUrl)}` ``). |
| `/auth/logout` | Ends the session and redirects to `APP_BASE_URL`. Linked directly as `<a href="/auth/logout">` in `pages/watch/[shareId].js` and elsewhere (no page component needed — it's a real route the SDK serves). |
| `/auth/callback` | Auth0's OAuth callback target. Must match the **Allowed Callback URLs** configured in the Auth0 dashboard application settings (`https://your-domain/auth/callback`, per README's one-time setup checklist). |
| `/auth/profile` | Returns the current session's profile as JSON. Not directly called by any page in this repo (the app reads the session server-side via `getSession` instead), but it's live because the SDK mounts it unconditionally. |

### v3 → v4 migration trap table

From README's "Upgrading from an older deployment?" note — relevant any
time you see old-SDK code or a stale dashboard config:

| v3 (old) | v4 (this repo) | Consequence of missing it |
|---|---|---|
| `AUTH0_BASE_URL` | `APP_BASE_URL` | Login redirect loop or wrong callback host |
| `AUTH0_ISSUER_BASE_URL` (with `https://`) | `AUTH0_DOMAIN` (bare hostname, **no scheme**) | Auth0Client fails to resolve the tenant |
| Routes at `/api/auth/*` | Routes at `/auth/*` | Auth0 dashboard's Allowed Callback URLs must point at `/auth/callback`, not `/api/auth/callback`, or login fails at the callback step |

### Session reads

Every server-side session check in this app goes through
`auth0.getSession(req)`, never through a client-side hook. Two call sites:

- **`lib/guard.js`** (`sessionEmail()`) — used by every `/api/**` route via
  `requireUser` / `requireApproved` / `requireAdmin`.
- **`getServerSideProps`** directly, in `pages/index.js`, `pages/admin.js`,
  `pages/watch/video/[id].js`, `pages/watch/[shareId].js` — each one calls
  `auth0.getSession(req)`, extracts `session?.user?.email`, and redirects to
  `/auth/login?returnTo=...` if absent.

**The session object's only identity input the app trusts is
`session.user.email`.** `session.user.name` is read too (for display, e.g.
`session.user.name || email` fallback), but every access-control decision —
`isAdmin()`, `isApprovedViewer()`, share-link recipient matching — is keyed
purely on the normalized email from `lib/auth.js`'s `normalizeEmail()`
(trim + lowercase). There is no role claim, no Auth0 "app_metadata" lookup,
nothing else consulted.

### Rolling sessions and why `proxy.js`'s matcher must stay broad

`proxy.js` (Next.js 16's replacement for `middleware.js`) is three lines of
substance:

```js
export async function proxy(request) {
  return auth0.middleware(request);
}
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
```

The file's own comment: *"Everything except static assets — the broad
matcher is required for rolling sessions to refresh on ordinary page/API
traffic."* Concretely: the Auth0 SDK extends session expiry on every request
that passes through its middleware. If the matcher were narrowed (e.g. to
exclude `/api/**` or watch pages), sessions would stop refreshing on those
routes and users could be logged out mid-session even while actively using
the app. Narrowing this matcher is a security-touching change per
`change-control`'s classification table.

---

## 3. bunny.net Stream as used here

All calls go through `lib/bunny.js`. Base URL:

```
https://video.bunnycdn.com
```

Every call to `/library/{libraryId}/...` is authenticated with an
`AccessKey` header set to `BUNNY_API_KEY` (see the `api()` helper). There is
no OAuth, no signed request for the management API itself — only for the
three playback/upload artifacts described below. Env values are read via a
local `env()` helper that **trims** the value defensively (comment: "a stray
newline in a pasted key corrupts TUS signatures and API calls").

### Every endpoint the app calls

| Function | Method + path | Purpose |
|---|---|---|
| `listVideos({page, itemsPerPage})` | `GET /videos?page=&itemsPerPage=&orderBy=date` | One page of the library, newest first. |
| `listAllVideos({maxPages})` | (wraps `listVideos`, paginated in parallel after page 1) | Full library, module-cached 4s per warm serverless instance (`VIDEO_LIST_CACHE_TTL_MS`). |
| `getVideo(id)` | `GET /videos/{id}` | Single video's metadata (status, title, guid, collectionId, thumbnailFileName, length). |
| `createVideo(title, collectionId)` | `POST /videos` | Creates the bunny.net video record before a TUS upload starts. Invalidates the list cache. |
| `updateVideo(id, patch)` | `POST /videos/{id}` | Rename / change collection. Invalidates the list cache. |
| `deleteVideo(id)` | `DELETE /videos/{id}` | Delete, or clean up a cancelled upload's half-created record. Invalidates the list cache. |
| `listCollections()` | `GET /collections?page=1&itemsPerPage=100&orderBy=date` | All collections for the homepage filter and admin collection manager. |
| `createCollection(name)` | `POST /collections` | Admin "create collection". |
| `deleteCollection(id)` | `DELETE /collections/{id}` | Admin "delete collection". |
| `getStatistics({dateFrom, dateTo})` | `GET /statistics?dateFrom=&dateTo=` | Views / watch-time data for the Analytics tab. |
| (no dedicated function — `signTusUpload()` builds the request the browser then makes) | `POST https://video.bunnycdn.com/tusupload` (TUS protocol) | The actual resumable file upload, made **directly by the admin's browser**, not by this server. |

### Video status codes

`videoState()` in `lib/bunny.js` maps bunny.net's numeric `status` field to
one of three UI states:

| Code | bunny.net meaning | App-mapped state |
|---|---|---|
| 0 | Created | processing |
| 1 | Uploaded | processing |
| 2 | Processing | processing |
| 3 | Transcoding | processing |
| 4 | Finished | **ready** |
| 5 | Error | **failed** |
| 6 | Upload failed | **failed** |
| 7+ | JIT (just-in-time) encoding states | **ready** (already playable) |

Exact logic: `status === 5 || status === 6` → `"failed"`;
`status === 4 || status > 6` → `"ready"`; everything else (0–3) →
`"processing"`. Only `"ready"` videos are ever shown to viewers
(`lib/videoList.js` filters on this before building the homepage list).

### The three keys, disambiguated

This is the single most common source of confusion in this codebase — three
different bunny.net keys, each used for a different signature, with one
silent fallback.

| Env var | Used for | Read by |
|---|---|---|
| `BUNNY_API_KEY` | (a) Authenticating every Stream management API call (the `AccessKey` header) **and** (b) part of the TUS upload signature formula | `apiKey()` in `lib/bunny.js`, used in `api()` and `signTusUpload()` |
| `BUNNY_TOKEN_AUTH_KEY` | Signing embed-view tokens (video playback) | `tokenAuthKey()`, used in `signEmbedUrl()`; also the **fallback** for thumbnail signing |
| `BUNNY_CDN_TOKEN_KEY` | Signing thumbnail URLs (pull-zone "Block Direct URL File Access" token auth) | `cdnTokenKey()` — `env("BUNNY_CDN_TOKEN_KEY") || tokenAuthKey()`. Only set this separately if the pull zone's token key genuinely differs from the library's embed token key. |

If you rotate `BUNNY_TOKEN_AUTH_KEY` in the bunny.net dashboard without
also checking whether `BUNNY_CDN_TOKEN_KEY` was relying on the fallback,
thumbnails silently start 401'ing while playback keeps working (or vice
versa) — the two are independent unless the fallback is in effect.

### The three signature formulas (verbatim)

All three are SHA-256 over a **concatenated string** (no delimiter, no
HMAC — plain digest). bunny.net independently recomputes and verifies each
one server-side; changing the concatenation order, the hash algorithm, or
the encoding here breaks playback/upload/thumbnails without any local error
— the failure only shows up as a bunny.net-side rejection. **CodeQL flags
these as "weak password hashing" — that is a false positive** (these are
per-request authorization tokens, not credential storage); see
`security-response` for the accepted-risk record.

| Artifact | Formula | Encoding | TTL |
|---|---|---|---|
| Embed token (`signEmbedUrl`) | `SHA256(BUNNY_TOKEN_AUTH_KEY + videoId + expires)` | hex | 3 hours (`ttlSeconds = 3 * 3600`) |
| TUS upload signature (`signTusUpload`) | `SHA256(libraryId + BUNNY_API_KEY + expire + videoId)` | hex | 6 hours (`ttlSeconds = 6 * 3600`) |
| Thumbnail token (`thumbnailUrl`) | `SHA256(cdnTokenKey + path + expires)` where `path` is `/{guid}/{thumbnailFileName}` | base64url (base64, then `+`→`-`, `/`→`_`, strip trailing `=`) | 6 hours (hardcoded `6 * 3600`, not parameterized) |

`expires` / `expire` in all three is a Unix timestamp in **seconds**
(`Math.floor(Date.now() / 1000) + ttlSeconds`), not milliseconds.

### The TUS upload flow, end to end

1. Admin drops a file in `pages/admin.js`'s upload UI. `startUpload(file)`
   runs client-side.
2. It first calls `POST /api/admin/upload` with `{ title }`
   (`pages/api/admin/upload.js`), which:
   - checks `requireAdmin`,
   - rate-limits via `allowRequest("upload", admin, 30, "1 h")`,
   - calls `createVideo(title, collectionId)` — this is the **only** step
     that touches bunny.net's management API; it creates an empty video
     record and returns its `guid`,
   - calls `logAction(admin, "video.upload", title)`,
   - responds `201` with `{ video: { id, title }, tus: signTusUpload(video.guid) }`
     — i.e. `{ endpoint, signature, expire, videoId, libraryId }`.
3. Back in the browser, `pages/admin.js` dynamically imports `tus-js-client`
   and constructs `new Upload(file, { endpoint: created.tus.endpoint, ... })`
   with headers `AuthorizationSignature`, `AuthorizationExpire`, `VideoId`,
   `LibraryId` taken verbatim from that response, then calls `upload.start()`.
4. From this point, **the file bytes go straight from the browser to
   `https://video.bunnycdn.com/tusupload`** — this app's server is not in
   the data path at all, only the auth handshake in step 2.
5. `onProgress` drives the progress bar; `onSuccess` marks the row `"done"`
   and calls `load()` to refresh the video list; `onError` surfaces the
   error and offers retry (`retryUpload`), which re-POSTs step 2 for a new
   signature (the old one may have expired) and restarts the same
   `tus-js-client` `Upload`.
6. Cancelling before completion calls `upload.abort(true)` client-side, then
   `DELETE /api/admin/upload?id=...` server-side, which calls `deleteVideo(id)`
   to remove the half-created bunny.net record and `pruneFromOrder(id)` to
   drop it from any saved homepage order.

### Embed iframe URL shape

```
https://iframe.mediadelivery.net/embed/{libraryId}/{videoId}?token={sha256hex}&expires={unixSeconds}&autoplay=false
```

Built by `signEmbedUrl()`. Note the host is `iframe.mediadelivery.net`, a
different domain from the Stream management API (`video.bunnycdn.com`) and
from the CDN pull zone (`BUNNY_CDN_HOSTNAME`) — three different bunny.net
hostnames serve three different purposes in this app. This URL is generated
fresh in `getServerSideProps` on every watch-page load
(`pages/watch/video/[id].js`, `pages/watch/[shareId].js`) and passed as the
iframe `src` to `ResumablePlayer` / the raw `<iframe>`. It is never persisted
to Redis or anywhere else.

### Thumbnails

- Default filename: `thumbnail.jpg` — used when `video.thumbnailFileName`
  is absent (`file = video.thumbnailFileName || "thumbnail.jpg"`).
- Requires `BUNNY_CDN_HOSTNAME` set; `thumbnailsEnabled()` gates the
  homepage's grid-vs-list rendering mode entirely on this one var.
- Signed with the thumbnail formula above when `cdnTokenKey()` resolves to
  something; if no key is available at all, `thumbnailUrl()` returns the
  bare unsigned `https://{host}{path}` (only correct if the pull zone's
  "Block Direct URL File Access" is off).
- README notes the pull zone also does **referer-based hotlink
  protection** as an additional layer, independent of the token.

---

## 4. Upstash Redis as used here

### Client shape

`lib/redis.js` wraps `@upstash/redis`'s `Redis` class — a **REST-based**
client, meaning every command (`hget`, `set`, `sadd`, ...) is one HTTPS
request, not a persistent TCP connection. Practical implications:

- **Objects auto-serialize to JSON** on write and deserialize on read — a
  share record stored as `{ videoId, email, ... }` via `r.set(key, share)`
  comes back as a real JS object from `r.get(key)`, no manual
  `JSON.parse`/`JSON.stringify` needed (contrast with `lib/audit.js`, which
  stores audit entries as explicit JSON **strings** via `JSON.stringify`
  before `lpush`, and so must `JSON.parse` them back in `recentActions()`).
- `hgetall` returns `{}` for a missing/empty hash, not `null` — but the app
  doesn't rely on that alone; every call site still does `(await
  redis().hgetall(...)) || {}` defensively (see `getSettings`,
  `listViewers`, `getProgress`).

### Key resolution

`lib/redis.js`'s `envBySuffix()` matches `KV_REST_API_URL` /
`KV_REST_API_TOKEN` (or the `UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN` fallback names) either as an exact env var name
or as a suffix of any env var name (comment: Vercel prefixes storage vars
with the store's name when a project has more than one connected, e.g.
`fablevideo_KV_REST_API_URL`). If you add a second Redis-backed integration
to this Vercel project, this suffix-matching logic is what keeps the app
finding the right credentials — or silently picking the wrong store's if
names collide.

### Complete key inventory

All keys are namespaced through `k(...parts)` in `lib/redis.js`, which
joins `"fablevideo"` with the given parts using `:`. (Historical note: the
prefix was `pvp:` before 2026-07-09, commit `c37919e`; anything under the
old prefix is orphaned data, not read by current code — see
`failure-archaeology` for the incident.)

| Key | Type | Written by | Read by | TTL |
|---|---|---|---|---|
| `fablevideo:settings` | hash | `saveSettings()` (`pages/api/admin/settings.js`) | `getSettings()` — homepage video count cap | none |
| `fablevideo:viewers` | hash, field = normalized email, value = `{addedAt, addedBy}` | `addViewers()` (`pages/api/admin/viewers.js`) | `listViewers()`, `isApprovedViewer()` — access gate | none |
| `fablevideo:lastseen` | hash, field = email, value = ISO timestamp | `stampLastSeen()` (called from `requireApproved` in `lib/guard.js`, best-effort) | `listViewers()` — admin Viewers tab | none |
| `fablevideo:order` | string (JSON array of video GUIDs) | `saveOrder()` (`pages/api/admin/order.js`) | `getOrder()` → `applyOrder()` (`lib/order.js`) — homepage/admin ordering | none |
| `fablevideo:theme` | string (JSON object `{preset, accent, accent2}`) | `saveTheme()` (`pages/api/theme.js` POST) | `getTheme()` (`pages/api/theme.js` GET, `pages/_app.js`) | none |
| `fablevideo:progress:<email>` | hash, field = videoId, value = `{t, d, at}` | `saveProgress()` (`pages/api/progress.js` POST, called by `ResumablePlayer`) | `getProgress()` (`pages/api/progress.js` GET — resume position + continue-watching list) | none |
| `fablevideo:share:<id>` | string (JSON share record) | `createShare()`, `updateShare()` (`pages/api/admin/share.js`, `pages/api/admin/share-email.js`, `pages/watch/[shareId].js`) | `getShare()`, `listShares()` | `ex` = `hours * 3600` at creation, **preserved** (not reset) on every `updateShare` |
| `fablevideo:shares:index` | set of share ids | `createShare()` (`sadd`), pruned in `listShares()`/`revokeShare()` (`srem`) | `listShares()` (`smembers`) | none (the set itself never expires; membership is opportunistically pruned when a member's record is found expired) |
| `fablevideo:audit` | list, capped, JSON-string entries | `logAction()` (`lib/audit.js`, called from nearly every admin mutation) | `recentActions()` (`pages/api/admin/audit.js` — Activity tab) | none; length capped to 200 via `ltrim(key, 0, 199)` after every `lpush` |
| `fablevideo:rl:<name>` | Ratelimit-internal keys (one family per limiter name/tokens/window combo) | `@upstash/ratelimit` internals via `limiterFor()` (`lib/ratelimit.js`) | same | window-scoped, managed by the `@upstash/ratelimit` library itself |
| `fablevideo:push:subs` | hash, field = browser push `endpoint`, value = `{ email, sub, addedAt }` | `savePushSubscription()` (`pages/api/push/subscribe.js` POST) | `listPushSubscriptions()` → `sendPushToApproved()`; pruned via `hdel` on dead endpoints and on unsubscribe | none |
| `fablevideo:push:notified` | set of video GUIDs already announced | `maybeAnnounceReadyVideos()` (`SADD` per newly-ready video, called from `pages/api/admin/videos.js`) | same (`SMEMBERS` to skip already-announced) | none |
| `fablevideo:push:seeded` | string sentinel `"1"` | `maybeAnnounceReadyVideos()` on its first run | same (existence check, so the first run seeds `notified` without blasting the whole existing library) | none |

### Share TTL lifecycle

1. **Create** (`createShare` in `lib/shares.js`): `ttlHours =
   clampShareHours(hours)` (clamped to 1–720 hours, i.e. up to 30 days;
   default 72 hours if unspecified/invalid). `r.set(shareKey(id), share, {
   ex: ttlHours * 3600 })` — Redis will hard-delete the key at expiry with
   no app-level cron needed.
2. **Update** (`updateShare`, used to stamp `viewedAt` on first play and
   `emailedAt` on send): reads the current record **and** its remaining TTL
   via `r.ttl(key)` in parallel, merges the patch, then writes back with
   `{ ex: ttl }` — i.e. it explicitly **preserves the remaining TTL** rather
   than resetting the clock to a fresh full duration. If `ttl <= 0` (key
   already gone or has no expiry) it returns `null` and does not write.
3. **List** (`listShares`): reads all ids from the index set, `mget`s all
   records in one round trip; any id whose record came back falsy (expired)
   is collected into `dead` and removed from the index via `srem` — this is
   the *only* place the index gets cleaned of naturally-expired entries, and
   it only happens as a side effect of an admin viewing the Shares tab.
4. **Revoke** (`revokeShare`): explicit `DEL` on the record plus `SREM` on
   the index — immediate, not TTL-dependent.

---

## 5. Resend as used here

`lib/email.js` talks to Resend's REST API directly — no `resend` npm SDK
dependency.

| Aspect | Detail |
|---|---|
| Endpoint | `POST https://api.resend.com/emails` |
| Auth | `Authorization: Bearer {RESEND_API_KEY}` header |
| Payload | `{ from, to: [to], subject, html, text }`, plus `reply_to` **only if** `EMAIL_REPLY_TO` is set (conditionally added, not sent as empty string) |
| Success | Any `res.ok` response — `sendEmail()` returns the parsed JSON body |
| Failure | Non-`ok` response: tries to parse a JSON body for a `.message` field to include in the thrown error; falls back to `` `status ${res.status}` `` if the body isn't parseable JSON. Always throws — callers (`pages/api/admin/share.js`, `share-email.js`) catch this and surface `emailError` in the admin UI rather than failing the whole request. |

**Inert-until-configured contract**: `emailEnabled()` is
`Boolean(env("RESEND_API_KEY") && env("EMAIL_FROM"))` — both must be set.
Every code path that might send email checks this first (e.g.
`pages/api/admin/share.js`: `if (shouldEmail && emailEnabled())`), so with
either var unset, share creation still succeeds and simply returns
`emailed: false` — there is no error, no attempted call, no partial state.
This is deliberate per README: "Without these, everything still works —
admins copy share links and send them manually."

**Domain verification requirement** (from README, not in code — nothing in
this repo checks it): the domain in `EMAIL_FROM` must be verified in
Resend's dashboard, or every send fails at Resend's end with a delivery
error that surfaces through the failure path above into the admin UI. This
is an operational prerequisite, not something `lib/email.js` can detect or
work around.

`siteName()` defaults to `"Marine Video Portal"` if `SITE_NAME` is unset —
used in the email subject line and body via `shareEmailTemplate()`, which
also HTML-escapes every interpolated value (`escapeHtml()`) before building
the HTML body, since `videoTitle` and the recipient email are admin/user
-influenced strings.

---

## 6. player.js / resume

`components/ResumablePlayer.js` wraps the tokenized bunny.net `<iframe>`
with the `player.js` npm package (bunny.net's embed implements the
player.js postMessage protocol on the iframe side; this component is the
protocol client on the host page).

Flow, in order:

1. The iframe renders immediately with the signed embed `src` — playback
   works even if the rest of this logic never runs.
2. On mount, `player.js` is **dynamically imported** (`await
   import("player.js")`) and a `new playerjs.Player(iframeRef.current)`
   instance is created, bound to the iframe via postMessage.
3. On the player's `"ready"` event: `GET /api/progress?videoId=...` fetches
   any previously saved position; if `saved.t > 5 && saved.d && saved.t <
   saved.d * 0.95` (i.e. more than 5 seconds in, and not already
   essentially finished), it calls `player.setCurrentTime(saved.t)` to seek
   there.
4. Still inside `"ready"`, it wires `"timeupdate"` (updates an in-memory
   `lastKnown = {t, d}` on every tick — no network call per tick),
   `"pause"` (saves immediately), and `"ended"` (sets `t = d` and saves —
   marks the video as finished for continue-watching filtering).
5. A `setInterval(save, 10000)` also persists every 10 seconds while
   playing, so a browser crash or tab close doesn't lose more than ~10s of
   progress.
6. `save()` itself is a guarded `POST /api/progress` with
   `{videoId, t: lastKnown.t, d: lastKnown.d}` — it no-ops if `d` is falsy
   or `t < 5` (nothing meaningful to persist yet), and uses
   `keepalive: true` so the request can complete even during page unload.
7. Cleanup (component unmount / `videoId` change): clears the interval and
   fires one last `save()`.

**Graceful degradation**: the whole `player.js` setup is wrapped in a
try/catch with the comment "player.js failed to load — plain embed playback
still works." If the dynamic import fails, or the protocol handshake never
completes, the raw `<iframe>` still plays the video; only resume/progress
tracking is lost, silently, with no user-visible error.

**Where progress lands**: `POST /api/progress`
(`pages/api/progress.js`) validates the payload (`videoId` string ≤100
chars, `t`/`d` finite numbers, `t >= 0`, `d > 0`) then calls
`saveProgress(email, videoId, {t, d, at})` in `lib/store.js`, which
`hset`s into `fablevideo:progress:<email>` — see the key inventory in
section 4. The same endpoint's plain `GET` (no `videoId`) powers the
homepage's "Continue watching" strip: it reads all progress entries,
filters to `t > 10 && d > 0 && t < d * 0.95` (started, has a real duration,
not basically finished), sorts by most recent, caps at 8
(`MAX_CONTINUE_ITEMS`), and enriches each with title/thumbnail via
`listAllVideos()`.

---

## 7. Rate limits as configured

Every limiter goes through `allowRequest(name, id, tokens, window)` in
`lib/ratelimit.js`, which lazily builds (and caches by
`` `${name}:${tokens}:${window}` ``) an `@upstash/ratelimit` instance using
`Ratelimit.slidingWindow(tokens, window)`, prefixed under
`fablevideo:rl:{name}`. **Fails open on any Redis error** — the whole
function is wrapped in try/catch returning `true` on failure, with the
comment "an infrastructure hiccup must never lock real users out." This
means rate limiting is best-effort, not a hard security boundary — do not
rely on it alone to bound abuse of an endpoint whose real risk is data
exposure (auth/authorization guards are the hard boundary there).

| Call site | `name` | Identity key | Tokens / window | User-visible message on 429 |
|---|---|---|---|---|
| `pages/api/admin/upload.js` (POST) | `"upload"` | admin's normalized email | 30 / 1 hour | `"Too many uploads started — try again shortly"` |
| `pages/api/admin/share.js` (POST) | `"share"` | admin's normalized email | 30 / 1 hour | `"Too many share links created — try again shortly"` |
| `pages/api/videos.js` (GET) | `"videos"` | viewer's normalized email | 60 / 1 minute | `"Too many requests — slow down a little"` |

All three key on **email**, not IP — meaning the limit is per-account, and
an admin/viewer with multiple tabs/devices shares one bucket. There is no
global/unauthenticated-endpoint limiter in this table because every rate-
limited route sits behind `requireAdmin`/`requireApproved` first, so the
identity used as the limiter key is always established before the limit
check runs.

---

## 8. Web Push and the PWA as used here

Added in v1.7.0 (installable PWA) and v1.8.0 (Web Push notifications). All of it is
**inert until VAPID keys are configured** — `pushEnabled()` in `lib/push.js` is
`Boolean(NEXT_PUBLIC_VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)`, and every server entry point
checks it first. See `environment-and-config` for the three env vars; this section is how
the pieces actually behave.

### The PWA shell (v1.7.0)

- **Manifest**: `public/manifest.webmanifest` — `name` "Marine Video Portal", `short_name`
  "Marine", `display: standalone`, `start_url`/`scope` `/`, theme/background `#0f172a`, and
  three icons (192, 512, and a 512 `maskable`). Linked from `pages/_document.js` via
  `<link rel="manifest" href="/manifest.webmanifest" />`.
- **Service worker**: `public/sw.js`, registered client-side in `pages/_app.js`
  (`navigator.serviceWorker.register("/sw.js")`, wrapped so a failure is silently ignored).
  On `install` it precaches the manifest + icons (`CACHE = "mvp-static-v1"`) and calls
  `skipWaiting()`; on `activate` it deletes stale caches and calls `clients.claim()`.
- **What makes it installable**: a linked manifest with the required icons + a registered
  service worker, served over HTTPS. Chrome then offers "Install app"; iOS/iPadOS offers
  "Add to Home Screen". Whether the browser shows a direct install entry vs. a generic
  "add to home screen / create shortcut" picker is a per-origin, per-device browser decision
  (Chrome's `AppBannerManager` engagement heuristic) — **not controllable from the
  manifest**, and not a bug in this app.

### Subscribe / unsubscribe flow (client)

`components/PushToggle.js` renders the "🔔 Notify me" button (becomes "🔔 Notifications on"
once subscribed). It:

1. No-ops entirely if `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is absent, the browser lacks
   `serviceWorker`/`PushManager`/`Notification`, or notifications are already `denied`
   (then it shows a "blocked in browser settings" chip).
2. On enable: `Notification.requestPermission()`, then
   `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey:
   urlBase64ToUint8Array(VAPID_PUBLIC_KEY) })`, then `POST /api/push/subscribe` with
   `{ subscription }`.
3. On disable: `getSubscription()`, `DELETE /api/push/subscribe` with `{ endpoint }`, then
   `subscription.unsubscribe()` locally.

### Server: `lib/push.js` (the whole feature)

| Function | What it does |
|---|---|
| `pushEnabled()` | `true` only when both VAPID vars are set. The gate for every path below. |
| `ensureVapid()` | Lazily calls `webpush.setVapidDetails(subject, public, private)` once. `subject` = `VAPID_SUBJECT` → else `APP_BASE_URL` → else `https://example.com`. |
| `savePushSubscription(email, sub)` | `HSET fablevideo:push:subs` keyed by the subscription's `endpoint`, value `{ email, sub, addedAt }`. One field per browser/device. |
| `removePushSubscription(endpoint, email)` | `HDEL` the endpoint — but **only if it belongs to `email`** (ownership check, so one viewer can't unsubscribe another). |
| `listPushSubscriptions()` | `HGETALL` → `[{ endpoint, email, sub }]`. |
| `sendPushToApproved(payload)` | Loads subs + the **live** approved-viewer list in parallel, keeps only subs whose `email` is a current viewer or admin, `webpush.sendNotification` to each, and prunes any endpoint that returns 404/410 (subscription gone). Returns `{ sent, pruned, configured }`. |
| `maybeAnnounceReadyVideos(videos)` | Fire-once "new video" announcer — see below. |

**The send-payload shape** is a small JSON blob `{ title, body, url }`; `public/sw.js`'s
`push` handler reads it (`event.data.json()`), shows `registration.showNotification(title,
{ body, icon: "/icon-192.png", badge: "/icon-192.png", data: { url } })`, and
`notificationclick` focuses an existing tab (navigating it to `url`) or opens a new window.

### The two send triggers

1. **Automatic, on a new video becoming ready.** `pages/api/admin/videos.js` (the admin
   video-list route) calls `maybeAnnounceReadyVideos(videos)` best-effort — wrapped in
   try/catch so a push failure never breaks the admin video list. Logic: filter to
   `status === "ready"` videos with an id; on the **first ever run**, `SADD` them all to
   `fablevideo:push:notified` and set the `fablevideo:push:seeded` sentinel **without
   sending** (so the pre-existing library isn't blasted); on later runs, for each ready
   video not already in `notified`, `SADD` it and send **only if `SADD` returned 1** (atomic
   — exactly one concurrent instance wins per video). Message: `{ title: "New video", body:
   video.title, url: "/watch/video/<id>" }`.
2. **Manual admin broadcast.** `POST /api/admin/notify` (`requireAdmin`, rate-limited
   **10/hour** per admin via `allowRequest("notify", ...)`, audit-logged as
   `"push.broadcast"`). Validates `title` (1–100 chars) and `body` (≤300 chars), clamps the
   click `url` to a same-origin path (`startsWith("/")` else `/`), calls
   `sendPushToApproved`, returns `{ ok, sent, pruned }`. Triggered from the admin Settings
   tab's broadcast card (`pages/admin.js`), which shows a setup hint naming
   `NEXT_PUBLIC_VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` when push is unconfigured.

### The two subscribe/notify routes, status codes

| Route | Guard | Notable responses |
|---|---|---|
| `POST/DELETE /api/push/subscribe` | `requireApproved` (admins count as approved) | `503` if `!pushEnabled()`; `400` if no `subscription.endpoint` (POST) / no `endpoint` (DELETE); `201` on subscribe; `405` otherwise |
| `POST /api/admin/notify` | `requireAdmin` | `503` if `!pushEnabled()`; `429` if over 10/hour; `400` on bad title/body length; `502` on send failure |

### iOS caveat (operational, from README, not enforceable in code)

iOS/iPadOS deliver Web Push **only to a PWA that's been installed to the Home Screen**
(Safari 16.4+), never to an ordinary Safari tab. So on iOS the "Notify me" button only does
anything after the user installs the app — this is an Apple platform constraint, not a bug
in `PushToggle.js`. Android Chrome and desktop Chrome/Edge/Firefox subscribe from a normal
tab without installing.

---

## Provenance and maintenance

- Verified by reading, on 2026-07-13: `lib/auth0.js`, `lib/auth.js`,
  `lib/guard.js`, `lib/redis.js`, `lib/store.js`, `lib/shares.js`,
  `lib/email.js`, `lib/ratelimit.js`, `lib/audit.js`, `lib/order.js`,
  `lib/theme.js`, `lib/theme-client.js`, `lib/bunny.js`, `lib/videoList.js`,
  `proxy.js`, `README.md`, `pages/api/admin/upload.js`,
  `pages/api/progress.js`, `pages/api/videos.js`,
  `pages/api/admin/share.js`, `pages/index.js`, `pages/admin.js` (upload
  section), `pages/watch/video/[id].js`, `pages/watch/[shareId].js`,
  `components/ResumablePlayer.js`, `package.json`.
- Repo state at time of writing: v1.6.0 (released 2026-07-07), Redis key
  prefix `fablevideo:` (since commit `c37919e`, 2026-07-09).
- **Updated 2026-07-15 (v1.8.0):** added section 8 (Web Push + PWA), four
  glossary rows (Web Push, VAPID, service worker, PWA), and the three
  `fablevideo:push:*` keys to the section-4 inventory — verified by reading
  `lib/push.js`, `public/sw.js`, `public/manifest.webmanifest`,
  `components/PushToggle.js`, `pages/_app.js`, `pages/_document.js`,
  `pages/api/push/subscribe.js`, and `pages/api/admin/notify.js` on that date.
  The iOS-install-required-for-push caveat is from README, not exercised here.
- **Volatile facts to re-check if this file feels stale**: the three
  signature TTLs (3h/6h/6h) and formulas in `lib/bunny.js`; the rate-limit
  table in section 7 (tokens/window are trivial to change and easy to drift
  from this doc); the Redis key inventory in section 4 (new features add
  keys); the video status code table in section 3 (bunny.net could add
  states). Re-grep the cited functions rather than trusting numbers here if
  more than a few weeks have passed.
- **Not independently verified** (asserted by README, not exercised
  against live services): Resend's actual error-message JSON shape on
  failure; the exact wording bunny.net returns on a rejected signature;
  whether Auth0's `/auth/profile` route response shape matches any
  assumption (no code in this repo actually calls it, so there is nothing
  to cross-check against).
- If any of `lib/auth0.js`, `lib/bunny.js`'s signature functions,
  `lib/redis.js`'s key prefix, or `lib/email.js`'s endpoint change, update
  this file in the same PR — it will otherwise actively mislead the next
  reader.
