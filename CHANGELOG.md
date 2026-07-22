# Changelog

All notable changes to Marine Video Portal are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Geo-location whitelist** — two independent country whitelists, each read
  from an env var (`GEO_WHITELIST`, `ADMIN_GEO_WHITELIST`) so they can always
  be edited directly in Vercel, and each gated by its own Redis-backed
  enforcement toggle in the Settings tab (off by default, no redeploy
  needed): **Enforce GEO_WHITELIST** restricts the entire site — including
  login — to the listed countries; **Enforce ADMIN_GEO_WHITELIST bypass**
  lets a visitor from one of *those* countries through regardless of
  `GEO_WHITELIST`, so an admin traveling somewhere the main whitelist
  doesn't cover can add their current country to `ADMIN_GEO_WHITELIST` in
  Vercel and redeploy — without needing the app to be reachable to fix it
  any other way. Enforced in `proxy.js` against Vercel's
  `x-vercel-ip-country` request header, before the Auth0 middleware runs,
  with the toggles cached a few seconds per instance like the video-list
  cache. A blocked visitor sees a generic "not available in your region"
  page with no details about which countries are allowed. Both lists are
  shown read-only in the Settings tab (`lib/geo.js`, `lib/geoBlockedPage.js`,
  `pages/api/admin/settings.js`).

## [1.11.0] - 2026-07-22

Recoverable share revocation, durable bundle links, and per-viewer watch
history — an accidental revoke is no longer permanent by default, a
recipient's bundle link is always reachable from the admin UI, and viewers
(and admins, on their behalf) can see a full watch history, not just what's
still in progress.

### Added

- **Soft revoke, restore, and permanent delete for share links** — revoking
  a link now flags it in place instead of deleting it, so an accidental
  revoke can be undone with the same id/URL and no re-notification. The
  Shares tab shows a "Revoked" badge with **Restore** and **Delete
  permanently** actions; Extend and email-resend explicitly refuse a
  revoked link rather than silently reviving it (`lib/shares.js`'s
  `revokeShare` / `unrevokeShare` / `permanentlyDeleteShare`, `PATCH
  /api/admin/shares` for restore, `DELETE /api/admin/shares` with
  `{ permanent: true }` for permanent delete).
- **Persistent bundle-link access** — a "Bundle pages" section in the
  Shares tab lists every recipient's bundle with a durable "Copy bundle
  link" button, and the bulk-share creation result now also surfaces each
  new/updated bundle's link — not just a one-time toast at share-creation
  time (`pages/api/admin/share-bulk.js`'s `bundleResults`).
- **"My activity" page** — a per-viewer watch history page (`/activity`,
  linked from the nav) listing every video the viewer has made progress
  on, finished or not, most-recent first, with a resume/rewatch link and
  progress bar. Backed by `GET /api/progress?all=1`, the uncapped,
  all-videos counterpart to the existing capped continue-watching list.
  Admins get a "View as" dropdown (populated from the approved-viewer
  list) to look up any approved viewer's history the same way
  (admin-only, and the target must itself be an approved viewer or admin —
  `GET /api/progress?all=1&email=...`).

## [1.10.0] - 2026-07-21

Email watermark, per-video share analytics, and bulk video operations —
deterrence against re-sharing recordings, at-a-glance share performance per
video, and faster housekeeping across many videos at once.

### Added

- **Email watermark** — an overlay of the viewer's email and a timestamp,
  tiled across the player, as a deterrent against re-sharing recordings.
  Resolved per play with a layered, most-specific-wins order: a
  per-recipient **exemption** always wins (never watermarked, regardless of
  anything else); then a per-share **Always/Never** choice, set in the
  single and bulk share forms; then a per-video override, set from a select
  in the Videos tab; otherwise a global default toggle in Settings applies.
  Exemptions (any viewer or admin email) are managed from Settings. Applies
  to both private share-link playback and direct approved-viewer playback
  (`lib/watermark.js`'s `resolveWatermark`, `components/WatermarkOverlay.js`,
  `pages/api/admin/watermark-exempt.js`).
- **Per-video share analytics** — a collapsible panel in the Analytics tab,
  and a per-row "Stats" toggle in the Videos tab, both rolling up existing
  per-share tracking by video: link count, unique recipients, views,
  playback starts, completions and completion rate, and average
  furthest-percent watched. Reads only fields already stored on share
  records (`lib/shares.js`'s `rollupShareAnalyticsByVideo`, also exposed
  from `pages/api/admin/shares.js`'s existing GET) — no new tracking or
  extra Redis reads are added.
- **Bulk video operations** — multi-select rows in the Videos tab and
  **bulk delete** or **move to a collection** in one action, mirroring the
  bulk-share UX. Each video is processed independently — one failure never
  blocks the rest — with a per-item success/failure report
  (`pages/api/admin/videos.js`'s `bulk-delete` / `bulk-set-collection`
  actions).

## [1.9.0] - 2026-07-21

Bulk sharing and recipient bundles — share several videos with several
people in one action, see who actually watched (not just who opened the
link), and manage links in bulk from the Shares tab.

### Added

- **Bulk video sharing** — select multiple videos in the admin Videos tab and
  share them with multiple recipients in one request. Creates one
  independently-revocable link per video × recipient pair (up to 200 pairs
  per request), and sends each recipient a single email listing only their
  own links (`pages/api/admin/share-bulk.js`, `lib/email.js`'s
  `bulkShareEmailTemplate`).
- **Per-link view and playback tracking** — every share link now tracks a
  view count and last-viewed time (every watch-page load, not just the
  first), plus real-playback stats reported by the Bunny player's own
  events: play count, furthest percentage watched, and completion
  (`components/ShareTrackedPlayer.js`, `POST /api/share-track`,
  `lib/shares.js`'s `shareViewPatch`/`sharePlaybackPatch`). Distinguishes
  who opened a link from who actually watched.
- **One consolidated bundle page per recipient** — once a recipient has 2 or
  more active share links (from one bulk action or accumulated over
  separate actions), they're grouped into a single bundle
  (`lib/bundles.js`), viewable on one page at `/watch/bundle/[bundleId]`,
  gated by the same Auth0-login-plus-email-match check as an individual
  share link. The bundle record is a pure list of share ids — every item's
  title/status is read live from its own share record on each load, so
  revoking or letting one item expire is reflected instantly with no write
  to the bundle. The first-ever bundle for a recipient sweeps in their
  other already-live, not-yet-bundled shares. A recipient's first (and
  only) share still gets the existing plain single-link email; once
  bundled, every later notification (including resends) becomes one
  consolidated email listing everything currently live for them, with a
  link to the bundle page.
- **Extend a share link's expiry in place** — a new "Extend" action
  (`pages/api/admin/share-extend.js`, single or bulk with per-item
  success/failure reporting) pushes a link's expiry out without changing
  its id/URL and without re-notifying the recipient — the missing
  symmetric counterpart to Revoke. Works on an already-expired-but-not-
  revoked link (share records now outlive their nominal expiry by a
  30-day grace window so they can still be extended — see
  `lib/shares.js`'s `GRACE_SECONDS`/`isShareLive`); a revoked link has no
  record left, so Extend can never double as a silent un-revoke.
  Extending a bundled item also extends its bundle's expiry to match.
- **Bulk resend** — multi-select rows in the Shares tab and hit "Resend N"
  to (re)send the delivery email for every selected link in one action
  (`pages/api/admin/share-email.js` now accepts `{ ids }` alongside the
  existing single-`{ id }` shape). Each link is resent independently and
  reported success/failure on its own — one bad or expired link never
  blocks the rest. Selected rows that share a bundled recipient are
  grouped before sending so that recipient gets one consolidated email,
  not a duplicate per row.
- **Bulk revoke** — multi-select rows in the Shares tab and hit "Revoke N"
  to kill every selected link in one action (`pages/api/admin/shares.js`'s
  `DELETE` now accepts `{ ids }` alongside the existing single-`?id=`
  shape). Each link is revoked independently — one bad id never blocks
  the rest — and revocation stays idempotent, same as before: revoking an
  id that's already gone still reports success.

## [1.8.1] - 2026-07-16

Documentation-only release — no runtime code changed.

### Documentation

- **README rewritten and reorganized** — leads with a four-state access model
  table (anonymous / signed-in-not-approved / approved viewer / admin) and makes
  the fail-closed (access) and fail-open (infrastructure) posture explicit,
  including the signed embed-token formula. Consolidates the full operational
  reference: environment-variable groups with secret-generation commands
  (`openssl rand -hex 32`, `npx web-push generate-vapid-keys`), the one-time
  setup checklist, the Auth0 v4 migration note, a symptom-to-fix troubleshooting
  section, and Redis/Upstash scaling notes.
- **FEATURES reorganized by audience** (viewers / share links / admin /
  platform), refreshed against the current code, and re-stamped to v1.8.0
  content (it had been left at v1.7.0). Retains the "Known gaps / not yet
  implemented" section.
- **Skill library version drift reconciled** across `.claude/skills/`.
- Added `README.original.md` and `FEATURES.original.md` as verbatim backups of
  the pre-rewrite documents.

## [1.8.0] - 2026-07-15

### Added

- **Push notifications (Web Push)** — approved viewers opt in with a "Notify
  me" button and are notified automatically when a new video becomes ready
  (announced once per video, via an atomic Redis guard). Admins can send a
  manual broadcast from the Settings tab. Sends target only currently-approved
  viewers/admins; dead subscriptions (HTTP 404/410) are pruned automatically.
  Inert until `NEXT_PUBLIC_VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` are set.
  Adds the `web-push` dependency and the service worker's `push` /
  `notificationclick` handlers.

## [1.7.0] - 2026-07-14

### Added

- **Installable PWA** — a web app manifest, app icons (standard + maskable),
  and Apple touch-icon/meta so the portal can be installed to a home screen and
  launched standalone. A minimal service worker (`public/sw.js`) makes it
  installable and caches only the static app icons — it deliberately never
  caches Auth0, `/api/*` responses, or signed video/thumbnail URLs.
- **Contributor skill library** (`.claude/skills/`) — 13 skills documenting the
  architecture contract, change-control gates, debugging playbook, security
  response, and more, plus runnable read-only diagnostic scripts. Documentation
  and tooling only; no runtime impact.

## [1.6.0] - 2026-07-07

First release.

A private, invite-only video portal built on Next.js 16 (Pages Router) and
React 19, hosted on Vercel, using bunny.net Stream for video storage/playback,
Auth0 for login, Upstash Redis for admin-managed data, and Resend for
automatic email delivery of private share links.

### Added

- **Authentication & access control** — Auth0 login gate on every page, a
  two-tier admin/approved-viewer model managed live from `/admin`, a
  server-side admin gate (`getServerSideProps` redirect + `403` on every
  `/api/admin/*` route), 30-minute idle auto sign-out, and sliding-window rate
  limiting on the video list, upload, and share-creation endpoints.
- **Homepage & viewer experience** — thumbnail grid (falls back to a title
  list without a CDN hostname configured), debounced search, collection
  filter chips, a Continue-watching strip with resume progress, pagination,
  admin-adjustable video count and custom ordering, and an admin-adjustable
  color palette with a no-flash pre-paint script.
- **Video playback & security** — every play uses a signed, time-limited
  bunny.net embed token generated fresh per request; no permanent or public
  video URL is ever used or exposed; thumbnails are CDN token-signed.
- **Video management (admin)** — browser-to-bunny.net TUS resumable upload
  with drag-and-drop, progress, and cancel/retry; encoding-status badges;
  rename, delete, drag-to-reorder, search; collections (create/delete/assign).
- **Private share links (admin)** — per-recipient one-off links with
  adjustable expiry (default 72h, capped at 30 days), automatic email
  delivery via Resend with a per-link opt-out, send/resend from the Shares
  tab, viewed-status tracking, instant revocation, and forced-login
  recipient-email matching that never reveals the intended recipient on a
  mismatch.
- **People & oversight (admin)** — approved-viewer management with bulk add,
  per-viewer last-seen time, an append-only activity/audit log, and an
  analytics dashboard (views, watch time, 30-day chart, most-watched).
- **Platform & quality** — opt-in Sentry error monitoring (client/server/edge,
  inert until a DSN is set), a GitHub Actions CI pipeline (lint + test +
  build on every push/PR to `main`), and Vitest smoke tests for auth, video
  ordering, theme helpers, and the share-email template.

### Performance

- Homepage now server-renders the first page of videos directly in
  `getServerSideProps` instead of fetching client-side after hydration,
  removing a full extra round trip.
- Multi-page bunny.net libraries fetch their remaining pages in parallel
  (previously sequential), and library reads are cached for 4 seconds per
  warm instance, invalidated immediately on any admin mutation.
- Search, collection filtering, and pagination now run entirely client-side
  against the already-fetched library, making them instant instead of
  round-tripping to the server on every keystroke or click.
- Removed `preload=true` from the signed embed URL so bunny.net's player no
  longer eagerly buffers video bytes before the viewer presses play.

### Known gaps

- No self-serve access-request flow — admins must know who to add.
- Access checks trust the Auth0 email claim; pair with sign-ups disabled (or
  `email_verified` enforcement) in the Auth0 tenant.
- Admins are configured via the `ADMIN_EMAILS` environment variable, not the
  UI.
- Captions/transcripts, comments/ratings, and scheduled publish/expiry are
  not implemented.

See [FEATURES.md](FEATURES.md) for the full, current feature list and
[README.md](README.md) for setup instructions.
