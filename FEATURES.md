# Features

A catalog of what the Marine Video Portal does, current as of **v1.9.0**.
Grouped by audience; items marked _(admin)_ live in the `/admin` panel. For
setup and architecture, see [README.md](./README.md).

---

## For viewers

### Sign-in and access control
- **Login required** for every page via Auth0 (`@auth0/nextjs-auth0` v4, routes
  at `/auth/*`).
- **Four-tier access model:** anonymous → signed-in-but-unapproved → approved
  viewer → admin. Unapproved users get a clear "not approved" message and never
  receive any video data. Approval **fails closed** — an infra error denies
  access rather than leaking content.
- **Server-side admin gate** — `/admin` checks the session and admin email in
  `getServerSideProps` and redirects non-admins before any UI is sent; every
  `/api/admin/*` route also independently returns `403`.
- **Idle timeout** — an open portal signs itself out after 30 minutes of
  inactivity, protecting sessions left open on shared machines.
- **Rolling sessions** — the session refreshes on ordinary page/API traffic so
  active users aren't logged out mid-session.
- **API rate limiting** (sliding window) on the video list, upload, share, and
  broadcast endpoints; fails open so an infrastructure hiccup never blocks real
  users.
- Centralized identity logic in one shared helper (`lib/auth.js`). Auth0
  sign-ups can be disabled tenant-wide so strangers can't self-register.

### Browsing the library
- **Modern dark design** — glassmorphism, gradient accents, Inter typography.
- **Admin-adjustable color palette** _(admin)_ — 7 presets plus custom hex
  colors, applied to **all** visitors; cached client-side with a no-flash
  pre-paint script so returning visitors never see a color flicker.
- **Thumbnail grid** — a responsive grid of 16:9 cards with duration badges and
  a play overlay when thumbnails are configured; falls back to a clean **title
  list** otherwise. Thumbnail URLs are **CDN token-signed** so they work with
  "Block Direct URL File Access" enabled.
- **Instant search** — the whole (admin-capped) library loads once, then search
  runs client-side against it (debounced) — no round trip per keystroke.
- **Collection filters** — narrow the library to a single collection via chips;
  filtering is instant and client-side.
- **Pagination** — 10 per page with Previous/Next, reset to page one whenever the
  search or collection filter changes.
- **Server-rendered first paint** — the library is fetched on the server and
  embedded in the initial HTML, so content appears without waiting for hydration
  plus a second fetch.
- **Admin-adjustable video count** _(admin)_ — hard cap enforced in code
  (bunny.net's API doesn't honor it as a strict limit).
- **Custom ordering** _(admin)_ — drag-to-reorder; newly uploaded videos float to
  the top (newest first) until placed.

### Watching
- **Tokenized playback** — every play uses a fresh, signed, time-limited
  bunny.net embed token generated per request, never a permanent or public URL.
  Autoplay is disabled on all embedded players.
- **Resume where you left off** — the player remembers each viewer's position per
  video (via player.js); reopening seeks back to the saved spot. Progress is
  saved on pause, on end, and periodically during playback. Degrades gracefully
  if the player protocol is unavailable — plain playback still works.
- **Continue-watching** — the homepage shows a strip of in-progress videos with
  progress bars, newest first. Finished and barely-started videos are excluded.

### Notifications & installable app
- **Push notifications** — approved viewers can opt in with a "Notify me" button
  and get a Web Push notification when a **new video becomes ready** (announced
  once per video, first run seeded silently). Sends only ever reach
  currently-approved viewers/admins, and dead subscriptions are pruned
  automatically. Inert until VAPID keys are configured; on iOS, push requires the
  PWA be installed to the Home Screen first (iOS 16.4+).
- **Installable (PWA)** — a web app manifest, app icons (standard + maskable), and
  Apple touch-icon/meta let visitors install the portal and launch it standalone.
  A deliberately minimal service worker caches only the static app icons — never
  Auth0, `/api/*` responses, or signed video/thumbnail URLs.

---

## Private share links (per-recipient sharing) _(admin)_

- Generate a one-off private link for any video, tied to a specific recipient
  email.
- **Automatic email delivery** — when email is configured (Resend), the recipient
  gets a branded email with the video title, a watch button, the exact expiry,
  and a note that the link only works for their address. Optional per-link
  (checkbox at creation).
- **Send / resend from the Shares tab** — one click emails an existing link (for
  links created before email was configured, failed sends, or lost emails). Each
  link shows an **Emailed** badge with the delivery time.
- **Failure-safe** — if an email send fails, the link is never lost: the admin
  sees the error, can copy the link manually, and can retry later.
- **Forced login** — opening the link requires an Auth0 login and only plays if
  the logged-in email matches the one specified. Wrong-account attempts show a
  generic mismatch message — **the intended recipient's email is never revealed**.
- **Adjustable expiry** per link (default 72 hours, capped at 720 / 30 days).
- **Bulk sharing** — select multiple videos in the Videos tab and share all of
  them with multiple recipients in one request. Every video × recipient pair
  gets its own independently-revocable link (up to 200 pairs per request), and
  each recipient gets exactly **one** email listing only their own links —
  never anyone else's.
- **View tracking** — each link tracks how many times its watch page was
  opened and when it was last opened, not just a single "viewed" stamp.
- **Real-playback tracking** — separately from page views, the Bunny player's
  own events (play, timeupdate, ended) report actual playback per link: how
  many times playback started, the furthest percentage watched, and whether
  it was watched to completion. This distinguishes someone who opened the
  link from someone who actually watched.
- **Instant revocation** — kill any active link immediately, one click, or
  select several and **bulk revoke** them in one action (each link revoked
  independently, per-link success/failure result).
- Expired/revoked links show a clean "expired or doesn't exist" message.
- **Unguessable IDs** — share IDs are random 16-byte tokens, format-validated
  before any lookup.
- **Extend expiry in place** — push a link's expiry out without changing its
  URL or re-notifying the recipient (the counterpart to Revoke). Works even
  on an already-expired-but-not-revoked link. Bulk extend mirrors bulk
  creation: multi-select, one hours value, per-link success/failure result.
- **Bulk resend** — multi-select links in the Shares tab and resend the
  delivery email for all of them in one action. Each link is resent
  independently with its own success/failure result; selected links that
  share a bundled recipient are grouped so that person gets one email, not
  a duplicate per selected row.
- **One consolidated bundle per recipient** — once someone has 2+ active
  share links (from one bulk action or built up over separate ones), they're
  automatically grouped into a single bundle page listing everything
  currently shared with them, gated the same way as an individual link.
  Revoking, expiring, or extending an individual item is reflected on the
  bundle page instantly — the bundle only ever stores a list of ids, never a
  copy of any item's title or status. A recipient's first share still gets a
  plain single-link email; every later notification (new shares, resends)
  becomes one consolidated email once they're bundled.
- **Email watermark, per link** — a Default / Always / Never selector when
  creating a share link (single or bulk) overrides the video's and the
  global watermark setting for that link. See "Email watermark" under
  People & oversight for the full layered resolution order.

---

## Video management _(admin)_

- **Upload directly from the browser to bunny.net** — TUS resumable upload with a
  progress bar, **drag-and-drop**, and **cancel/retry** for in-progress uploads
  (a cancelled upload cleans up its half-created video). The file never passes
  through the app server.
- **Encoding status** — per-video "Processing %" / "Failed" badges,
  auto-refreshing while anything is encoding.
- **Rename** videos inline.
- **Delete** videos (removes from bunny.net and prunes them from the saved order).
- **Drag-to-reorder** and **search/filter** the library.
- **Collections** — create/delete collections and assign each video to one.
- **Bulk operations** — multi-select videos and **bulk delete** or **move to
  a collection** in one action, mirroring the bulk-share UX. Each video is
  processed independently (one failure never blocks the rest), with a
  per-item success/failure report.
- **Per-video watermark override** — a Default / Always / Never select per
  video overrides the global watermark setting for every share of that
  video (unless a per-share or exemption override applies — see "Email
  watermark" below).
- **Per-video share analytics, inline** — a "Stats" toggle per video row
  expands the same share-link rollup shown in the Analytics tab (link
  count, unique recipients, views, started/completed, avg progress) without
  leaving the Videos tab.

---

## People & oversight _(admin)_

- **Approved viewer management** — add/remove emails, with **bulk add** (paste
  comma/space/newline-separated lists; validated + deduped, with invalid entries
  reported back).
- **Viewer last-seen** — each viewer's most recent activity time.
- **Activity / audit log** — the most recent admin actions (viewer add/remove,
  share create/revoke/**email**, video rename/delete/reorder, collection
  create/delete, settings, palette), each with actor and time. Logging is
  best-effort so it never breaks the underlying action.
- **Analytics dashboard** — total views, 30-day views, watch time, video count, a
  30-day views chart, and a most-watched list (from bunny.net video stats + the
  statistics API).
- **Per-video share analytics** — a collapsible panel rolling up existing
  per-share tracking by video: link count, unique recipients, views,
  playback starts, completions and completion rate, and average
  furthest-percent watched. Reads only fields already stored on share
  records — no new tracking is added.
- **Manual push broadcast** — send a notification to every currently approved
  viewer (and admins); click-through targets are restricted to same-origin paths.
- **Content-protection panel** — explains the tokenized-playback model and the bunny.net "Block Direct URL File Access" setting.
- **Email watermark** — overlays the viewer's email and a timestamp on
  playback as a deterrent against re-sharing recordings. Layered,
  most-specific-wins resolution: a per-recipient **exemption** (managed in
  Settings, applies to any viewer or admin email) always wins; then a
  per-share Always/Never choice (set at share creation); then a per-video
  override (Videos tab); otherwise a global on/off default (Settings tab)
  applies. Applies to both private share-link playback and direct
  approved-viewer playback.

## Admin panel structure _(admin)_
- **Tabbed layout** — Videos, Viewers, Shares, Settings, Activity, Analytics — so
  admins jump straight to a section instead of one long scroll. Live count badges
  on Viewers/Shares.
- All admin API routes return `403` for non-admins rather than exposing any data.

---

## Platform, quality & observability

- Hosted on Vercel; dependencies install automatically during deploy (no local
  Node/npm required to ship).
- Next.js 16 (Pages Router) + React 19; Auth0 session handling runs in the Next
  16 `proxy.js` network boundary.
- Settings, viewers, order, collections, share records, watch history, and the
  audit log are stored in Upstash Redis (via Vercel Storage), editable live from
  `/admin` without redeploying. All keys are namespaced with a `fablevideo:`
  prefix.
- **Opt-in Sentry error monitoring** — client/server/edge configs via the
  instrumentation hooks; inert until `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` are
  set.
- **CI pipeline** — GitHub Actions runs lint + tests + build on every push/PR to
  `main`, catching breakage before Vercel deploys.
- **Smoke tests** — Vitest coverage for the auth check, video-ordering logic,
  theme helpers, and the share-email template.

## Configuration knobs (environment)
- `RESEND_API_KEY` + `EMAIL_FROM` — enable automatic email delivery of share
  links (`EMAIL_REPLY_TO`, `SITE_NAME` optional).
- `BUNNY_CDN_HOSTNAME` — enables thumbnails; `BUNNY_CDN_TOKEN_KEY` signs them when
  the pull-zone token key differs from the embed key.
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` — enable Web Push.
- `NEXT_PUBLIC_SITE_NAME` — portal name in the header.
- `SENTRY_*` — enable error monitoring and source-map upload.

---

## Known gaps / not yet implemented

- **Access-request flow** — no self-serve way for unapproved users to request
  access; admins must know who to add.
- **`email_verified` enforcement** — access checks trust the email claim; pair
  with Auth0 sign-up controls (see Security notes in the README).
- **In-app admin management** — admins are configured via `ADMIN_EMAILS`, not the
  UI.
- **Captions/transcripts, comments/ratings, scheduled publish/expiry** — not
  implemented.
