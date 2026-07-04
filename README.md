# Marine Video Portal

A private, invite-only video site built with **Next.js 16** (Pages Router), hosted on **Vercel**, using **bunny.net Stream** for video storage/playback, **Auth0** (`@auth0/nextjs-auth0` v4) for login, **Upstash Redis** (via Vercel Storage) for admin-managed settings, collections, share links, watch history, and the audit log, and **Resend** for automatic email delivery of private share links.

Videos are never public: every play uses a **signed, time-limited bunny.net token** generated fresh on each request. Access is gated to an admin-managed list of approved viewers, with per-recipient private share links for one-off sharing — emailed to the recipient automatically when email delivery is configured.

---

## How it works

- Visiting the site requires logging in via Auth0.
- Only **approved viewers** (managed live by an admin) see the video library. Everyone else sees a clear "not approved" message after logging in.
- The homepage shows the library — as a **thumbnail grid** when thumbnails are configured, otherwise a title list — with **search**, **collection filters**, and a **Continue watching** strip that resumes videos where the viewer left off. It's paginated and capped at an admin-controlled count.
- Clicking a video opens a watch page that plays it in a tokenized bunny.net embed and remembers playback position.
- Admins manage everything from a tabbed **`/admin`** panel: upload videos, organize the library, manage viewers and share links (with one-click **email delivery**), adjust the site's color palette, and view analytics and an activity log.
- `/admin` is gated **server-side** (redirects non-admins before any UI is sent) and every `/api/admin/*` route independently returns `403` for non-admins.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (Pages Router), React 19 |
| Hosting | Vercel |
| Video | bunny.net Stream (tokenized embeds, TUS resumable upload, collections, statistics) |
| Auth | Auth0 (`@auth0/nextjs-auth0` v4 — routes mounted at `/auth/*` via `proxy.js`) |
| Data | Upstash Redis (`@upstash/redis`) via Vercel Storage |
| Email | Resend REST API (share-link delivery; no SDK dependency) |
| Rate limiting | `@upstash/ratelimit` |
| Error monitoring | Sentry (`@sentry/nextjs`), opt-in |
| Uploads | `tus-js-client` (browser → bunny.net) |
| Playback resume | `player.js` |
| Tests / CI | Vitest + GitHub Actions (lint + test + build) |

---

## Project structure

```
proxy.js                  Next.js 16 network boundary — mounts Auth0 /auth/* routes,
                          keeps rolling sessions alive (replaces middleware.js)
pages/
  _app.js                 Theme bootstrap, Inter font, idle-timeout mount
  _document.js            No-flash palette script (applies cached theme pre-paint)
  index.js                Homepage — thumbnail grid/list, search, collections, continue-watching
  admin.js                Tabbed admin panel (server-gated) — Videos/Viewers/Shares/Settings/Activity/Analytics
  api/
    videos.js             Page of videos for approved viewers (search + collection filter, rate-limited)
    collections.js        Collection list for the homepage filter (approved viewers)
    progress.js           Per-viewer playback progress / watch history
    theme.js              Public GET palette; admin POST to update it
    admin/
      videos.js           List (ordered) / rename / set-collection / delete
      viewers.js          List (with last-seen) / add (single or bulk) / remove
      settings.js         Homepage video count + email-delivery status
      order.js            Custom homepage video order
      share.js            Create a private share link (rate-limited, auto-emails recipient)
      share-email.js      Send/resend the email for an existing share link
      shares.js           List / revoke active share links (viewed + emailed status)
      upload.js           Create Bunny video + signed TUS auth (rate-limited)
      collections.js      Create / list / delete collections
      audit.js            Recent admin actions
      analytics.js        Views, watch time, 30-day chart, most-watched
  watch/
    video/[id].js         Plays a library video for an approved viewer (resumable)
    [shareId].js          Plays a video via a private share link (forced login + email match)
components/
  AppShell.js             Header/layout shell
  IdleTimeout.js          30-minute inactivity auto sign-out
  ResumablePlayer.js      Wraps the Bunny embed via player.js for resume + progress
  icons.js                Inline SVG icons
lib/
  auth0.js                Auth0 v4 client (session handling)
  auth.js                 Shared isAdmin(email) + email helpers, used everywhere
  guard.js                API guards: requireUser / requireApproved / requireAdmin
  bunny.js                Bunny API: videos, collections, TUS signing, signed embed
                          URLs, thumbnail URLs (token-signed), statistics
  redis.js                Upstash Redis connection + key prefix helper k()
  store.js                Settings, viewers, order, theme, progress (Redis-backed)
  shares.js               Share-link records (TTL), viewed/emailed stamps, listing
  email.js                Resend delivery + share-link email template (inert until configured)
  order.js                Apply custom video order (new uploads float to top, newest first)
  theme.js                Palette presets, validation
  theme-client.js         Apply + cache palette in the browser
  audit.js                Append-only admin action log (capped)
  ratelimit.js            Sliding-window limiter (fails open)
  __tests__/              Vitest smoke tests (auth, order, theme, email)
styles/globals.css        Design system (dark glassmorphism, gradient accents, Inter)
instrumentation.js        Sentry server/edge init hook (opt-in)
instrumentation-client.js Sentry client init (opt-in)
sentry.{server,edge}.config.js  Opt-in Sentry init (inert without a DSN)
next.config.js            Wrapped with withSentryConfig
vitest.config.js          Test config (node env)
eslint.config.mjs         ESLint flat config (next/core-web-vitals)
.github/workflows/ci.yml  Lint + test + build on push/PR to main
```

---

## Environment variables (Vercel → Settings → Environment Variables)

### Required

| Key | Description |
|---|---|
| `AUTH0_SECRET` | Random 32-byte hex string encrypting the session cookie. Generate with `openssl rand -hex 32`. |
| `APP_BASE_URL` | Exact site URL, e.g. `https://your-app.vercel.app` (no trailing slash). |
| `AUTH0_DOMAIN` | Auth0 tenant domain **without** `https://`, e.g. `your-tenant.us.auth0.com`. |
| `AUTH0_CLIENT_ID` | From the Auth0 application settings. |
| `AUTH0_CLIENT_SECRET` | From the Auth0 application settings. |
| `BUNNY_LIBRARY_ID` | bunny.net Stream library ID. |
| `BUNNY_API_KEY` | bunny.net Stream library API key. |
| `BUNNY_TOKEN_AUTH_KEY` | bunny.net library's Embed View Token Authentication key (Security tab). |
| `ADMIN_EMAILS` | Comma-separated admin emails, e.g. `you@example.com,other@example.com`. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Auto-injected when a Redis/Upstash database is connected via Vercel's Storage tab. |

> Upgrading from an older deployment? `@auth0/nextjs-auth0` v4 renamed `AUTH0_BASE_URL` → `APP_BASE_URL` and `AUTH0_ISSUER_BASE_URL` → `AUTH0_DOMAIN` (no scheme), and the auth routes moved from `/api/auth/*` to `/auth/*` — update the callback/logout URLs in the Auth0 dashboard.

### Optional — email delivery of share links

| Key | Description |
|---|---|
| `RESEND_API_KEY` | Resend API key. Together with `EMAIL_FROM`, enables automatic emailing of share links. |
| `EMAIL_FROM` | Sender, e.g. `Marine Video Portal <videos@yourdomain.com>`. The domain must be verified in Resend. |
| `EMAIL_REPLY_TO` | Optional reply-to address. |
| `SITE_NAME` | Portal name used in emails (default "Marine Video Portal"). |

Without these, everything still works — admins copy share links and send them manually.

### Optional — other

| Key | Description |
|---|---|
| `BUNNY_CDN_HOSTNAME` | Library CDN/pull-zone host (e.g. `vz-xxxx-xxx.b-cdn.net`). **Required for thumbnails** — without it the homepage falls back to the title list. |
| `BUNNY_CDN_TOKEN_KEY` | Pull zone's URL Token Authentication key. Only needed if it differs from `BUNNY_TOKEN_AUTH_KEY` and "Block Direct URL File Access" is on. |
| `NEXT_PUBLIC_SITE_NAME` | Portal name shown in the header/title (default "Marine Video Portal"). |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | Enable Sentry error capture (server / client). Inert if unset. |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | Enable Sentry source-map upload during build. |

After adding or changing any variable, **redeploy** — changes only apply to new deployments.

---

## One-time setup checklist

1. **bunny.net** — create a Stream library, enable **Embed View Token Authentication** (Security tab), upload videos (or upload them from `/admin` later). Note the CDN/pull-zone hostname for `BUNNY_CDN_HOSTNAME` if you want thumbnails.
2. **Auth0** — create a Regular Web Application. Set **Allowed Callback URLs** to `https://your-domain/auth/callback` and **Allowed Logout URLs** to `https://your-domain` (note: `/auth/callback`, not `/api/auth/callback` — this is the v4 SDK path). **Disable open sign-ups** (Authentication → Database → "Disable Sign Ups") and add people manually under User Management → Users, so strangers can't self-register.
3. **Resend** (optional, for share-link emails) — create an account, verify your sending domain, create an API key. Set `RESEND_API_KEY` and `EMAIL_FROM`.
4. **Vercel** — import the GitHub repo, connect a Redis/Upstash database under Storage, add the environment variables above, deploy.
5. Log in with an `ADMIN_EMAILS` account → `/admin` → set the homepage video count, add approved viewers, upload/organize videos, pick a palette.

---

## Local development

Node/npm are **not required** to deploy (Vercel installs everything), but they're handy for local work and verification.

```bash
npm install       # install dependencies
npm run dev       # local dev server at http://localhost:3000
npm run lint      # ESLint (flat config, next/core-web-vitals)
npm test          # Vitest smoke tests
npm run build     # production build
```

You'll need the environment variables above in a local `.env.local` to run against real services.

### CI

Every push / PR to `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml): **lint → test → build**. A broken build fails the check before Vercel deploys it. Consider enabling branch protection to require the check on PRs.

---

## Admin panel (`/admin`)

Tabbed layout, gated server-side to `ADMIN_EMAILS`:

- **Videos** — upload (drag-and-drop, progress, cancel/retry), rename, delete, drag-to-reorder, search, encoding-status badges, per-video collection assignment, and per-video private share-link creation (with an "email the link" option). Also a Collections manager (create/delete).
- **Viewers** — add/remove approved emails, **bulk add** (paste a list), and each viewer's **last-seen** time.
- **Shares** — every active private link with recipient, expiry, **viewed/not-viewed** status, and **emailed** status; email/resend the link with one click; revoke instantly.
- **Settings** — homepage video count, the site **color palette** (7 presets + custom, applied to all visitors), the email-delivery status panel, and a content-protection info panel.
- **Activity** — the most recent admin actions (add/remove viewer, share create/revoke/email, video rename/delete/reorder, settings, palette, collections).
- **Analytics** — total views, 30-day views, watch time, video count, a 30-day views chart, and a most-watched list.

---

## Email delivery of share links

When `RESEND_API_KEY` and `EMAIL_FROM` are set:

- Creating a share link (Videos tab → Share) emails the recipient automatically — a branded message with the video title, a watch button, the exact expiry, and a note that the link only works for their email address.
- The Shares tab shows an **Emailed** badge (with timestamp) per link and an **Email / Resend** button for links created before email was configured, failed sends, or lost emails.
- Email failures never lose the link: the admin sees the error, can copy the link manually, and can retry the send later. Sends are recorded in the activity log.

The sending domain must be verified in Resend or delivery will fail (the error surfaces in the admin UI).

---

## Security notes

- **Access is by email identity.** Admin, approved-viewer, and share-recipient checks all compare the session's email (normalized). Because of this, keep Auth0 **sign-ups disabled** (or require verified email) so nobody can self-register as an approved/admin address. Centralized identity logic lives in `lib/auth.js` — update it there only.
- **`/admin` is gated server-side** via `getServerSideProps` (redirects non-admins), and every `/api/admin/*` route independently returns `403`.
- **Playback is always tokenized** — signed, time-limited embed URLs generated per request; no permanent public URL is used or exposed.
- **Share-link mismatches don't reveal** the intended recipient's email.
- **Thumbnails** are served from the CDN and, when a token key is present, are **signed** so they keep working with "Block Direct URL File Access" enabled. Requests from the app carry the site's `Referer`, so hotlink protection still blocks direct/off-site access.
- **Rate limiting** guards the video list, upload, and share-creation endpoints (fails open if the limiter backend is unavailable).
- **Idle sign-out** logs users out after 30 minutes of inactivity.
- Direct bunny.net CDN file URLs (`*.b-cdn.net/.../playlist.m3u8`, `play_720p.mp4`) are never used by the app; if you want them fully locked down, enable **Block Direct URL File Access** on the library's Security tab.

---

## Common issues

- **Thumbnails show as a title list** — `BUNNY_CDN_HOSTNAME` isn't set (or the deploy hasn't picked it up). The grid only appears once the API returns thumbnail URLs.
- **Thumbnails 403 directly but load in the app** — expected: that's referrer-based hotlink protection. The app works; direct/off-site access is blocked.
- **Share emails aren't sending** — check that `RESEND_API_KEY` and `EMAIL_FROM` are set and the deploy picked them up, and that the `EMAIL_FROM` domain is verified in Resend. The exact error appears in the admin UI when a send fails.
- **Login loops or "callback URL mismatch"** — the Auth0 application's Allowed Callback URLs must contain `https://your-domain/auth/callback` (v4 path). Also confirm `APP_BASE_URL` matches the exact production URL with no trailing slash.
- **Resume doesn't work** — the Bunny embed must expose the player.js protocol; playback still works either way. Check the browser console/network for `/api/progress` calls.
- **`npm install` fails on deploy** — usually a stray `package-lock.json`/`yarn.lock` committed alongside `package.json` (they're gitignored here on purpose), or a peer-dependency mismatch after a manual version bump.
- **Upload fails with HTTP 401** — a stray newline/space in `BUNNY_API_KEY`/`BUNNY_LIBRARY_ID` corrupts the TUS signature (the app trims them; re-paste cleanly in Vercel if it recurs).

---

## Scaling notes (Redis/Upstash)

A homepage visit costs a small, fixed number of Redis commands (viewer check, homepage count, video order, last-seen, plus collections/progress reads). At ~1,000 visits/day this stays well under typical free-tier limits. Watch history and the audit log add bounded writes. If traffic grows into the 10,000+ daily-visit range, move the rarely-changing settings (viewer list, count, order, palette) to Vercel Edge Config to cut Redis load, leaving Redis for the TTL-based share links and per-viewer progress.
