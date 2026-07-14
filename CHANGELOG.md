# Changelog

All notable changes to Marine Video Portal are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Installable PWA** — a web app manifest, app icons (standard + maskable),
  and Apple touch-icon/meta so the portal can be installed to a home screen and
  launched standalone. A minimal service worker (`public/sw.js`) makes it
  installable and caches only the static app icons — it deliberately never
  caches Auth0, `/api/*` responses, or signed video/thumbnail URLs.

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
