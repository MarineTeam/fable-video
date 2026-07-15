# Marine Video Portal

A private, invite-only video portal. Approved viewers sign in, browse a curated
library, and watch videos through signed, time-limited playback tokens. Admins
upload and organize videos, manage who has access, and share individual videos
with specific people through private, expiring links.

Videos are hosted and transcoded on [bunny.net Stream](https://bunny.net/stream/);
the app itself never stores or serves video files directly. Every layer that can
leak content — playback embeds, thumbnails, share links — is access-controlled
and time-limited.

- **Framework:** Next.js 16 (Pages Router) · React 19
- **Auth:** Auth0 (`@auth0/nextjs-auth0` v4)
- **Video:** bunny.net Stream (TUS uploads, tokenized embeds)
- **State:** Upstash Redis
- **Email:** Resend
- **Notifications:** Web Push (VAPID)
- **Monitoring:** Sentry
- **Hosting:** Vercel

---

## How access works

Every request resolves to one of four states, compared by normalized
(lowercased, trimmed) email:

| State | Who | What they see |
| --- | --- | --- |
| **Anonymous** | Not signed in | Redirected to Auth0 login |
| **Signed in, not approved** | Authenticated but not on the viewer list | A clear "not approved yet" message — no video data |
| **Approved viewer** | On the viewer list in Redis | The full library, watch pages, resume, notifications |
| **Admin** | Email listed in `ADMIN_EMAILS` | Everything a viewer sees, plus the `/admin` panel |

Admins are always treated as approved. Approval checks **fail closed** — if Redis
is unreachable, a viewer is treated as not approved rather than accidentally
granted access. Every `/api/admin/*` route re-checks admin status on its own,
independently of the page-level gate.

---

## Getting started

### Prerequisites

- Node.js **20.9+** (CI builds on Node 22)
- An [Auth0](https://auth0.com/) application (Regular Web App)
- A [bunny.net](https://bunny.net/) Stream video library
- An [Upstash Redis](https://upstash.com/) database (or Vercel KV)

### Install and run

```bash
npm install
npm run dev
```

The app runs at `http://localhost:3000`. There is **no committed lockfile** by
design — local installs, CI, and Vercel each resolve dependencies fresh against
the caret ranges in `package.json`.

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint (`eslint-config-next` core-web-vitals) |
| `npm test` | Run the Vitest suite |

---

## Configuration

All configuration is through environment variables — there are no config files
or feature flags. Set these in `.env.local` for local development, or in the
Vercel project's Environment Variables tab for deploys.

### Required

| Variable | Description |
| --- | --- |
| `AUTH0_DOMAIN` | Auth0 tenant domain (e.g. `your-tenant.us.auth0.com`) |
| `AUTH0_CLIENT_ID` | Auth0 application client ID |
| `AUTH0_CLIENT_SECRET` | Auth0 application client secret |
| `AUTH0_SECRET` | 32-byte hex secret for session encryption |
| `APP_BASE_URL` | Public base URL of the app (e.g. `https://portal.example.com`) |
| `ADMIN_EMAILS` | Comma-separated list of admin email addresses |
| `BUNNY_LIBRARY_ID` | bunny.net Stream library ID |
| `BUNNY_API_KEY` | bunny.net Stream API key (uploads, video CRUD) |
| `BUNNY_TOKEN_AUTH_KEY` | Token authentication key for signing embed URLs |
| `KV_REST_API_URL` | Upstash Redis REST URL (or `UPSTASH_REDIS_REST_URL`) |
| `KV_REST_API_TOKEN` | Upstash Redis REST token (or `UPSTASH_REDIS_REST_TOKEN`) |

> Redis credentials are matched by suffix, so Vercel's store-prefixed names
> (e.g. `fablevideo_KV_REST_API_URL`) are picked up automatically when a project
> has more than one storage integration connected.

### Optional

**Thumbnails** — without these, the homepage falls back to a title list.

| Variable | Description |
| --- | --- |
| `BUNNY_CDN_HOSTNAME` | Pull-zone hostname; enables thumbnails |
| `BUNNY_CDN_TOKEN_KEY` | CDN token-signing key (defaults to `BUNNY_TOKEN_AUTH_KEY`) |

**Email delivery** — required to auto-email share links. When unset, sharing
still works and links are copied manually.

| Variable | Description |
| --- | --- |
| `RESEND_API_KEY` | Resend API key |
| `EMAIL_FROM` | Verified sender address |
| `EMAIL_REPLY_TO` | Optional reply-to address |
| `SITE_NAME` | Name shown in email subject/body (default: "Marine Video Portal") |

**Web Push notifications** — inert until both VAPID keys are set.

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | VAPID public key (exposed to the browser) |
| `VAPID_PRIVATE_KEY` | VAPID private key |
| `VAPID_SUBJECT` | `mailto:` or `https:` subject (defaults to `APP_BASE_URL`) |

**Branding & monitoring**

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_SITE_NAME` | Portal name shown in the header and tab title |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | Enables server / client error capture |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | Source-map upload at build time |

---

## Architecture

### Request flow

`proxy.js` is the Next.js 16 network boundary (the replacement for
`middleware.js`). It mounts the Auth0 routes (`/auth/login`, `/auth/logout`,
`/auth/callback`, `/auth/profile`) and keeps rolling sessions alive on every
request. Its matcher covers all traffic except static and PWA assets, so
sessions refresh on ordinary page loads without churning the manifest, service
worker, or icons.

### Data layers

- **bunny.net** is the source of truth for videos, collections, and view
  statistics. The full video list is cached briefly (a few seconds) per warm
  serverless instance so that search, filtering, and pagination don't re-fetch
  the whole library — any admin mutation invalidates that cache immediately.
- **Redis** (prefix `fablevideo:`) holds all app-owned state: approved viewers,
  last-seen timestamps, the custom homepage order, site settings, the theme,
  per-viewer playback progress, share records, the audit log, rate-limit
  counters, and push subscriptions.

### Playback security

Video files are never served or linked directly. Each playback uses a fresh,
time-limited embed token (`SHA256(tokenKey + videoId + expires)`) generated per
request and never stored. Thumbnails are CDN-token-signed the same way, so they
keep working with bunny.net's "Block Direct URL File Access" enabled. Uploads go
straight from the admin's browser to bunny.net over signed TUS credentials — the
file never passes through the app server.

### Resilience patterns

- **Fail closed on access:** approval and share-recipient checks deny on error.
- **Fail open on infrastructure:** rate limiting and audit logging never block a
  real user if Redis hiccups.
- **Best-effort side effects:** last-seen stamps, push announcements, and audit
  entries never break the action they accompany.

---

## Project layout

```
pages/
  index.js              Homepage: library grid/list, search, filters, resume
  admin.js              Admin panel (Videos, Viewers, Shares, Settings, Activity, Analytics)
  watch/video/[id].js   Approved-viewer playback with resume
  watch/[shareId].js    Private share-link playback
  api/                  Viewer and admin JSON endpoints
lib/
  auth.js  auth0.js  guard.js   Identity, Auth0 client, route guards
  bunny.js                      bunny.net Stream client, token signing
  redis.js  store.js  shares.js State, viewers/progress/settings, share links
  email.js  push.js             Resend delivery, Web Push
  ratelimit.js  audit.js        Sliding-window limits, admin action log
  videoList.js  order.js  theme.js  Viewer library, custom order, palette
components/
  AppShell.js  ResumablePlayer.js  PushToggle.js  IdleTimeout.js  icons.js
proxy.js                Auth0 network boundary + rolling sessions
```

See [FEATURES.md](./FEATURES.md) for a full catalog of what the portal does.

---

## Deployment

The app is built for [Vercel](https://vercel.com/). Push to the default branch
and Vercel builds and deploys automatically. Add every required environment
variable to the project before the first deploy, and **redeploy after changing
any variable** — env changes only take effect on a new build.

CI (GitHub Actions, `.github/workflows/ci.yml`) runs on every push and pull
request to `main` and mirrors the deploy: `npm install`, then lint, test, and
build. Because there is no lockfile, a green local run and a red CI run usually
mean a freshly published dependency version.

---

## License

Private project — access by invitation only.
