# Marine Video Portal

A private, invite-only video portal built with **Next.js 16** (Pages Router) and
hosted on **Vercel**. Approved viewers sign in, browse a curated library, and
watch videos through signed, time-limited playback tokens. Admins upload and
organize videos, manage who has access, and share individual videos with
specific people through private, expiring links.

Videos are never public: every play uses a fresh **bunny.net embed token**
generated per request, and the app itself never stores or serves video files
directly. See [CHANGELOG.md](CHANGELOG.md) for release notes and
[FEATURES.md](FEATURES.md) for a full feature catalog.

- **Framework:** Next.js 16 (Pages Router) · React 19
- **Auth:** Auth0 (`@auth0/nextjs-auth0` v4)
- **Video:** bunny.net Stream (TUS uploads, tokenized embeds)
- **State:** Upstash Redis (via Vercel Storage)
- **Email:** Resend · **Notifications:** Web Push (VAPID) · **Monitoring:** Sentry

---

## How access works

Every request resolves to one of these states, compared by normalized
(lowercased, trimmed) email:

| State | Who | What they see |
| --- | --- | --- |
| **Anonymous** | Not signed in | Redirected to Auth0 login |
| **Signed in, not verified** | `REQUIRE_VERIFIED_EMAIL` is on and the claim isn't true | A "verify your email" message — no video data, no role lookup |
| **Signed in, not approved** | Authenticated, no viewer record and no role | A "not approved yet" message with a **Request access** button — no video data |
| **Viewer** | On the viewer list in Redis | Watch pages, resume, notifications, and the library — the whole library, or just their groups' videos if any of their groups is restricted |
| **Manager** | Role `manager` in Redis | Everything a viewer sees (unscoped), plus the Videos, Shares, Activity and Analytics tabs of `/admin` |
| **Admin** | Role `admin` in Redis, or listed in `ADMIN_EMAILS` | Everything, including the Viewers, Groups and Settings tabs |

### Roles

Three roles, each a strict superset of the one below it, resolved in
`lib/roles.js` against a capability table (`lib/capabilities.js`):

| Capability | Viewer | Manager | Admin |
| --- | :---: | :---: | :---: |
| Watch the library | ✅ | ✅ | ✅ |
| `videos.manage` — upload, rename, delete, reorder, collections | | ✅ | ✅ |
| `shares.manage` — create, extend, revoke, email share links | | ✅ | ✅ |
| `insights.view` — analytics and the activity log | | ✅ | ✅ |
| `people.manage` — viewers, roles, groups, watermark exemptions | | | ✅ |
| `settings.manage` — settings, palette, cleanup, broadcasts | | | ✅ |

Roles are stored in Redis and changed from **`/admin` → Viewers** with no
redeploy. `ADMIN_EMAILS` still works and is deliberately **not** replaceable
from the UI: its addresses are admins unconditionally, resolve without any
Redis call, and cannot be demoted through the panel. That is the recovery
path — if the role data is ever emptied or corrupted, an `ADMIN_EMAILS`
address can still sign in and repair it.

An admin cannot change their own role, and removing someone from the viewer
list also clears any role they held (a role grants access on its own, so
leaving it behind would silently keep them in).

### Groups

A group is a viewer tag with rules attached (**`/admin` → Groups**). Membership
is still the tag itself, edited from the Viewers tab, so every tag that existed
before groups shipped keeps working unchanged. A group may optionally be
**restricted** to an explicit list of videos:

- A tag with no group record, or a group left unrestricted, is a plain label —
  it grants and restricts nothing.
- A member of a **restricted** group sees only that group's videos.
- Belonging to several groups means the **union of the restricted ones**. An
  unrestricted group never widens a restricted one back to the full library,
  so a stray extra tag can't defeat a restriction.
- Managers and admins are never group-scoped — they need the whole library.

Scoping is enforced **server-side** on the library fetch, `/api/videos`,
`/api/collections`, continue-watching, and the watch page itself, which returns
404 for an out-of-scope video before any embed token is minted. Hiding a video
from a list is not access control. Share links are unaffected: they are an
explicit per-recipient grant that stands on its own.

Approval and role resolution **fail closed** — if Redis is unreachable, the
caller is treated as unapproved and unprivileged rather than accidentally
granted access, and a viewer whose group scope can't be resolved sees nothing
rather than everything. `/admin` is gated server-side (anyone without a staff
role is redirected before any UI is sent), and every `/api/admin/*` route
re-checks its own required capability independently of the page-level gate.

> Because access is by email identity, keep Auth0 **sign-ups disabled** (or
> require verified email) so nobody can self-register as an approved or admin
> address. Centralized identity logic lives in `lib/auth.js`.

- Visiting the site requires logging in via Auth0.
- Only **approved viewers** (managed live by an admin) see the video library. Everyone else sees a clear "not approved" message after logging in.
- The homepage shows the library — as a **thumbnail grid** when thumbnails are configured, otherwise a title list — with **search**, **collection filters**, and a **Continue watching** strip that resumes videos where the viewer left off. It's paginated and capped at an admin-controlled count.
- Clicking a video opens a watch page that plays it in a tokenized bunny.net embed and remembers playback position.
- Admins manage everything from a tabbed **`/admin`** panel: upload videos, organize the library, manage viewers, roles, groups and share links (with one-click **email delivery**), adjust the site's color palette, and view analytics and an activity log. **Managers** get the same panel minus the Viewers, Groups and Settings tabs.
- `/admin` is gated **server-side** (redirects anyone without a staff role before any UI is sent) and every `/api/admin/*` route independently returns `403` unless the caller holds that route's capability.
- The portal is an **installable PWA** — visitors can add it to a home screen and launch it standalone. A minimal service worker (`public/sw.js`) caches only the static app icons; it never caches Auth0, `/api/*` responses, or signed video/thumbnail URLs.
- **Push notifications** (optional) — approved viewers can opt in with a "Notify me" button. They're notified automatically when a new video becomes ready, and admins can send a manual broadcast from the Settings tab. Requires VAPID keys (see env vars); inert without them.



---

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (Pages Router), React 19 |
| Hosting | Vercel |
| Video | bunny.net Stream (tokenized embeds, TUS resumable upload, collections, statistics) |
| Auth | Auth0 (`@auth0/nextjs-auth0` v4 — routes mounted at `/auth/*` via `proxy.js`) |
| Data | Upstash Redis (`@upstash/redis`) via Vercel Storage |
| Email | Resend REST API (share-link delivery; no SDK dependency) |
| Rate limiting | `@upstash/ratelimit` (sliding window, fails open) |
| Notifications | Web Push (`web-push`, VAPID) |
| Error monitoring | Sentry (`@sentry/nextjs`), opt-in |
| Uploads | `tus-js-client` (browser → bunny.net) |
| Playback resume | `player.js` |
| Tests / CI | Vitest + GitHub Actions (lint + test + build) |

---

## Getting started

### Prerequisites

- Node.js **20.9+** (CI builds on Node 22)
- An [Auth0](https://auth0.com/) application (Regular Web App)
- A [bunny.net](https://bunny.net/) Stream video library
- An [Upstash Redis](https://upstash.com/) database (or Vercel KV)

Node/npm are **not required** to deploy (Vercel installs everything), but they're
handy for local work and verification.

```bash
npm install       # install dependencies
npm run dev       # local dev server at http://localhost:3000
npm run lint      # ESLint (flat config, next/core-web-vitals)
npm test          # Vitest smoke tests
npm run build     # production build
```

You'll need the environment variables below in a local `.env.local` to run
against real services. There is **no committed lockfile** by design — local
installs, CI, and Vercel each resolve dependencies fresh against the caret
ranges in `package.json`.

---

## Environment variables

All configuration is through environment variables — there are no config files
or feature flags. Set them in `.env.local` locally, or in **Vercel → Settings →
Environment Variables** for deploys. **After adding or changing any variable,
redeploy** — changes only apply to new deployments.

### Required

| Key | Description |
| --- | --- |
| `AUTH0_SECRET` | Random 32-byte hex string encrypting the session cookie. Generate with `openssl rand -hex 32`. |
| `APP_BASE_URL` | Exact site URL, e.g. `https://your-app.vercel.app` (no trailing slash). |
| `AUTH0_DOMAIN` | Auth0 tenant domain **without** `https://`, e.g. `your-tenant.us.auth0.com`. |
| `AUTH0_CLIENT_ID` | From the Auth0 application settings. |
| `AUTH0_CLIENT_SECRET` | From the Auth0 application settings. |
| `ADMIN_EMAILS` | Comma-separated admin emails, e.g. `you@example.com,other@example.com`. |
| `BUNNY_LIBRARY_ID` | bunny.net Stream library ID. |
| `BUNNY_API_KEY` | bunny.net Stream library API key (uploads, video CRUD). |
| `BUNNY_TOKEN_AUTH_KEY` | bunny.net library's Embed View Token Authentication key (Security tab). |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Auto-injected when a Redis/Upstash database is connected via Vercel's Storage tab (`UPSTASH_REDIS_REST_URL` / `_TOKEN` also accepted). |

> **Redis credentials are matched by suffix.** If a Vercel project has more than
> one storage integration connected, Vercel prefixes the injected names with the
> store's name (e.g. `fablevideo_KV_REST_API_URL`); the app resolves any variable
> *ending in* the expected name automatically — no action needed beyond
> redeploying after the store is connected.

> **Upgrading from an older deployment?** `@auth0/nextjs-auth0` v4 renamed
> `AUTH0_BASE_URL` → `APP_BASE_URL` and `AUTH0_ISSUER_BASE_URL` → `AUTH0_DOMAIN`
> (no scheme), and the auth routes moved from `/api/auth/*` to `/auth/*` — update
> the callback/logout URLs in the Auth0 dashboard.

### Optional — thumbnails

Without these, the homepage falls back to a title list.

| Key | Description |
| --- | --- |
| `BUNNY_CDN_HOSTNAME` | Library CDN/pull-zone host (e.g. `vz-xxxx-xxx.b-cdn.net`). **Required for thumbnails.** |
| `BUNNY_CDN_TOKEN_KEY` | Pull zone's URL Token Authentication key. Only needed if it differs from `BUNNY_TOKEN_AUTH_KEY` and "Block Direct URL File Access" is on. |

### Optional — email delivery of share links

Without these, sharing still works — admins copy links and send them manually.

| Key | Description |
| --- | --- |
| `RESEND_API_KEY` | Resend API key. Together with `EMAIL_FROM`, enables automatic emailing of share links. |
| `EMAIL_FROM` | Sender, e.g. `Marine Video Portal <videos@yourdomain.com>`. The domain must be verified in Resend. |
| `EMAIL_REPLY_TO` | Optional reply-to address. |
| `SITE_NAME` | Starting portal name, used until an admin sets one in **Settings → Site name** (default "Marine Video Portal"). Applies to the header, page titles, and emails. |

### Optional — push notifications

Inert until both VAPID keys are set. Generate them with
`npx web-push generate-vapid-keys`.

| Key | Description |
| --- | --- |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | VAPID public key (browser-safe). |
| `VAPID_PRIVATE_KEY` | VAPID private key (**secret** — server only, never `NEXT_PUBLIC_`). |
| `VAPID_SUBJECT` | Optional `mailto:`/`https:` contact sent to push services (defaults to `APP_BASE_URL`). |

> **iOS only delivers push to the PWA once it's installed to the Home Screen**
> (iOS/iPadOS 16.4+).

### Optional — geo-location whitelist

`GEO_WHITELIST` and `ADMIN_GEO_WHITELIST` are lists only — each is inert
until its matching enforcement toggle is switched on from the admin
**Settings** tab (both toggles default off, and are Redis-backed like other
admin settings). Restricting either list to env vars, rather than making
them admin-editable too, means an admin can always fix their own access by
editing Vercel's env vars and redeploying, even if the site (or the admin
panel specifically) is currently blocking them. `ADMIN_GEO_BYPASS_EMAILS`
has no toggle — it always applies once set.

| Key | Description |
| --- | --- |
| `GEO_WHITELIST` | Comma-separated ISO 3166-1 alpha-2 country codes, e.g. `US,CA`. When enforcement is on, restricts the **entire site** (including login) to these countries. |
| `ADMIN_GEO_WHITELIST` | Same format. When its own enforcement toggle is on, a visitor from one of these countries always gets through, regardless of `GEO_WHITELIST` — a safety valve for an admin traveling somewhere the main whitelist doesn't cover. |
| `ADMIN_GEO_BYPASS_EMAILS` | Comma-separated admin emails, e.g. `admin@example.com,second@example.com`. A signed-in visitor whose email is on this list always gets through, regardless of country and regardless of either toggle above. Arm this before traveling — it's a standing safety net, not an in-the-moment fix, since env var changes only take effect on redeploy. |

### Optional — require a verified email

| Key | Description |
| --- | --- |
| `REQUIRE_VERIFIED_EMAIL` | Set to `true`/`1`/`on`/`yes` (case/whitespace-insensitive) to refuse any session whose Auth0 `email_verified` claim isn't true. Unset or any other value keeps the check off. |

Access is by email identity, so an unverified address is an unproven claim to
one. With this on, an unverified session is refused everywhere — the homepage
shows a "verify your email" panel and every API route returns `403` — before
any approval or role lookup runs.

Two deliberate choices. It is **off by default**, because an existing portal's
viewers predate the check and Auth0 connections differ in whether they populate
the claim at all; turning it on unannounced would lock real people out. And a
**missing** claim counts as unverified, so a connection that simply doesn't send
the field can't silently disable the check.

`ADMIN_EMAILS` addresses are exempt, for the same reason they can't be demoted
from the UI: they're the recovery path. If you switch this on and your own claim
turns out to be missing, you can still sign in and switch it back off.

> This is a complement to, not a replacement for, keeping Auth0 **sign-ups
> disabled** — see the Security notes below.

### Optional — Query Monitor (performance panel)

A single env var turns on an in-app performance panel (in the spirit of the
WordPress `query-monitor`/`wp-memory-usage` plugins): a small floating widget,
visible to signed-in users, reporting Redis query count/time, outbound
third-party API calls (bunny.net, Resend, web-push) count/time, the page's
server-render cost, client render time, and process memory/uptime for the
current view — click it to expand a per-request breakdown.

| Key | Description |
| --- | --- |
| `QUERY_MONITOR_ENABLED` | Set to `true`/`1`/`on`/`yes` (case/whitespace-insensitive) to turn the panel on. Unset or any other value keeps it off. |

Deliberately **one** server-side var, not a server + `NEXT_PUBLIC_` pair: the
browser learns whether the monitor is on at runtime from `/api/monitor`
(which 404s outright when the flag is off, and requires a signed-in session
otherwise — process stats are never exposed to a logged-out visitor). That
also means flipping it doesn't require a rebuild — only a redeploy on Vercel,
same as any other env var change. When it's off, instrumentation is a single
cheap env-var check per Redis/API call and nothing else; call sites are
otherwise untouched.

### Optional — branding & monitoring

| Key | Description |
| --- | --- |
| `NEXT_PUBLIC_SITE_NAME` | Alternative spelling of `SITE_NAME`, kept for existing deployments. `SITE_NAME` wins if both are set, and the admin-set name wins over either. |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | Enable Sentry error capture (server / client). Inert if unset. |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | Enable Sentry source-map upload during build. |

---

## One-time setup checklist

1. **bunny.net** — create a Stream library, enable **Embed View Token
   Authentication** (Security tab), upload videos (or upload from `/admin`
   later). Note the CDN/pull-zone hostname for `BUNNY_CDN_HOSTNAME` if you want
   thumbnails.
2. **Auth0** — create a Regular Web Application. Set **Allowed Callback URLs** to
   `https://your-domain/auth/callback` and **Allowed Logout URLs** to
   `https://your-domain` (note: `/auth/callback`, not `/api/auth/callback` — this
   is the v4 SDK path). **Disable open sign-ups** (Authentication → Database →
   "Disable Sign Ups") and add people manually under User Management → Users, so
   strangers can't self-register.
3. **Resend** (optional, for share-link emails) — create an account, verify your
   sending domain, create an API key. Set `RESEND_API_KEY` and `EMAIL_FROM`.
4. **Vercel** — import the GitHub repo, connect a Redis/Upstash database under
   Storage, add the environment variables above, deploy.
5. Log in with an `ADMIN_EMAILS` account → `/admin` → set the homepage video
   count, add approved viewers, upload/organize videos, pick a palette.

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
  roles, groups, access requests, video schedules, the site name,
  last-seen timestamps, the custom homepage order, site
  settings, the theme, per-viewer playback progress, share records, the audit
  log, rate-limit counters, and push subscriptions. Everything is editable live
  from `/admin` without redeploying.

### Playback security

Video files are never served or linked directly. Each playback uses a fresh,
time-limited embed token (`SHA256(tokenKey + videoId + expires)`) generated per
request and never stored. Thumbnails are CDN-token-signed the same way, so they
keep working with bunny.net's "Block Direct URL File Access" enabled, and they
carry the site's `Referer` so hotlink protection blocks direct/off-site access.
Uploads go straight from the admin's browser to bunny.net over signed TUS
credentials — the file never passes through the app server.

### Resilience patterns

- **Fail closed on access:** approval and share-recipient checks deny on error.
- **Fail open on infrastructure:** rate limiting and audit logging never block a
  real user if Redis hiccups.
- **Best-effort side effects:** last-seen stamps, push announcements, and audit
  entries never break the action they accompany.

---

## Project structure

```
proxy.js                  Next.js 16 network boundary — mounts Auth0 /auth/* routes,
                          keeps rolling sessions alive (replaces middleware.js)
pages/
  _app.js                 Theme bootstrap, Inter font, idle-timeout mount
  _document.js            No-flash palette script (applies cached theme pre-paint)
  index.js                Homepage — thumbnail grid/list, search, collections, continue-watching
  activity.js             "My activity" — per-viewer full watch history (server-gated)
  admin.js                Tabbed admin panel (server-gated) — Videos/Viewers/Shares/Settings/Activity/Analytics
  api/
    videos.js             Page of videos for approved viewers (rate-limited)
    collections.js        Collection list for the homepage filter (approved viewers)
    progress.js           Per-viewer playback progress / watch history (continue-watching + full history)
    theme.js              Public GET palette; admin POST to update it
    push/subscribe.js     Register/remove a viewer's Web Push subscription
    share-track.js        Real-playback events (play/progress/ended) for one share link
    admin/
      videos.js           List (ordered) / rename / set-collection / delete (announces new-ready videos)
      notify.js           Manual admin push broadcast (rate-limited)
      viewers.js          List (with last-seen) / add (single or bulk) / remove
      settings.js         Homepage video count + email/push status
      order.js            Custom homepage video order
      share.js            Create a private share link (rate-limited, auto-emails recipient;
                           attaches to/creates the recipient's bundle)
      share-bulk.js        Bulk-create one link per video x recipient pair (rate-limited)
      video-shares.js      Per-video "Private list" — list/add/remove people, scoped to
                           shares the list itself created (add skips existing list
                           members; remove revokes immediately; rate-limited on add)
      share-extend.js      Extend one or more links' expiry in place (single or bulk)
      share-email.js      Send/resend the email (single or bulk; bundle-consolidated if bundled)
      shares.js           List / revoke (soft) / restore / permanently delete share links, single
                          or bulk (view/playback stats, emailed status)
      upload.js           Create Bunny video + signed TUS auth (rate-limited)
      collections.js      Create / list / delete collections
      audit.js            Recent admin actions
      analytics.js        Views, watch time, 30-day chart, most-watched
  watch/
    video/[id].js         Plays a library video for an approved viewer (resumable)
    [shareId].js          Plays a video via a private share link (forced login + email match)
    bundle/[bundleId].js  Lists everything currently shared with one recipient (same gate)
components/
  AppShell.js             Header/layout shell
  PushToggle.js           "Notify me" opt-in button (Web Push subscribe/unsubscribe)
  IdleTimeout.js          30-minute inactivity auto sign-out
  ResumablePlayer.js      Wraps the Bunny embed via player.js for resume + progress
  ShareTrackedPlayer.js   Wraps the Bunny embed via player.js for share-link playback tracking
  ShareGateMessage.js     Shared "link/bundle isn't available" card (share + bundle pages)
  icons.js                Inline SVG icons
lib/
  auth0.js                Auth0 v4 client (session handling)
  auth.js                 Email normalization + the ADMIN_EMAILS bootstrap seed (isEnvAdmin)
  capabilities.js         Role/capability policy — pure, storage-free, client-safe
  roles.js                Redis-backed roles + resolveAccess (role, approval, video scope)
  groups.js               Viewer groups: per-video allowlists over the existing tags
  accessRequests.js       Self-serve access requests (queue only — never grants)
  schedule.js             Per-video publish/expiry windows
  siteName.js             Site-name resolution + page-title helper (pure, client-safe)
  guard.js                API guards: requireUser / requireAccess / requireCapability
  bunny.js                Bunny API: videos, collections, TUS signing, signed embed
                          URLs, thumbnail URLs (token-signed), statistics
  redis.js                Upstash Redis connection + key prefix helper k()
  store.js                Settings, viewers, order, theme, progress (Redis-backed)
  shares.js               Share-link records (app-level expiry + grace-window TTL), view/
                          playback tracking, extend, soft revoke/restore, permanent delete
  bundles.js              One-bundle-per-recipient grouping (ids only, always read live)
  email.js                Resend delivery + share/bundle email templates (inert until configured)
  push.js                 Web Push subscriptions + send + new-video announce (inert until configured)
  videoList.js            Viewer-facing library (ordered, ready-only, signed thumbnails)
  order.js                Apply custom video order (new uploads float to top, newest first)
  theme.js                Palette presets, validation
  theme-client.js         Apply + cache palette in the browser
  audit.js                Append-only admin action log (capped)
  ratelimit.js            Sliding-window limiter (fails open)
  __tests__/              Vitest tests — pure logic plus resolveAccess and the
                          first API route coverage (helpers/route.js harness)
styles/globals.css        Design system (dark glassmorphism, gradient accents, Inter)
public/
  manifest.webmanifest    PWA manifest (name, icons, standalone display)
  sw.js                   Service worker — caches only the static app icons
  icon-192.png            App icon (192×192)
  icon-512.png            App icon (512×512)
  icon-maskable-512.png   Maskable app icon (512×512, adaptive/Android)
  apple-touch-icon.png    iOS home-screen icon
instrumentation.js        Sentry server/edge init hook (opt-in)
instrumentation-client.js Sentry client init (opt-in)
sentry.server.config.js   Sentry Node.js runtime init (opt-in)
sentry.edge.config.js     Sentry Edge runtime init (opt-in)
next.config.js            Wrapped with withSentryConfig
.github/workflows/ci.yml  Lint + test + build on push/PR to main
```

---

## Admin panel (`/admin`)

Tabbed layout, gated server-side to staff roles, with live count badges on
Viewers/Shares. Which tabs render depends on the caller's capabilities — a
manager sees Videos, Shares, Activity and Analytics only. That is a
convenience, not the authorization boundary: the routes behind each tab
enforce it independently.

- **Videos** — upload (drag-and-drop, progress, cancel/retry), rename, delete,
  drag-to-reorder, search, encoding-status badges, per-video collection
  assignment, a per-video **watermark override** (Default/Always/Never), a
  a per-video **Schedule** (publish-at / expires-at window, with Scheduled and
  Expired badges), a per-row **Stats** toggle showing that video's share-link
  analytics inline,
  per-video private share-link creation (with an "email the link" option),
  and **multi-select bulk sharing** (select several videos, share them with
  several recipients in one request) as well as **bulk delete** and **bulk
  move to a collection**. Includes a Collections manager (create/delete).
  A per-video **"Private list"** button opens a persistent, editable panel
  of everyone added to that one video's list — add several emails at once
  (only the ones not already on the list get a new share and a
  notification; existing list members are untouched), and remove someone to
  revoke their access immediately. A "Notify new people by email" checkbox
  (on by default) controls only the notification, not whether the share is
  created. The list is scoped strictly to shares it created itself — a link
  to the same video and person made from the regular Share/Bulk share
  button is separate, isn't shown on the list, and isn't touched by
  Remove.
- **Viewers** — a queue of pending **access requests** to approve or deny,
  plus add/remove approved emails, **bulk add** (paste a list), each
  viewer's **last-seen** time, per-viewer **tags** (group membership), and a
  per-viewer **role** select (Viewer/Manager/Admin). Addresses that are admins
  via `ADMIN_EMAILS` show a read-only "Admin (env)" chip instead, and you
  cannot change your own role.
- **Groups** — create groups, see member counts, and optionally **restrict** a
  group to an explicit list of videos so its members see only those. Tags
  already in use that have no group record are listed so they can be promoted
  to one. Deleting a group drops its restriction; members keep the tag as a
  plain label.
- **Shares** — every share link with recipient, expiry, **view count/last
  viewed**, **playback** (plays, furthest % watched, completed), **bundled**
  status, and **emailed** status; email/resend, extend expiry, and revoke —
  each single or **multi-select bulk**, with per-link success/failure
  results (email is bundle-consolidated when bundled). Creating a link
  (single or bulk) includes a **watermark** override.
- **Settings** — the **site name** (header, page titles, and share emails —
  applied to all visitors immediately, no redeploy), homepage video count, the
  site **color palette** (7 presets +
  custom, applied to all visitors), the **email watermark** global default
  and exemption list, a **geo-location whitelist** (two independent
  enable/disable toggles — `GEO_WHITELIST` and the `ADMIN_GEO_WHITELIST`
  bypass — plus a toggle-free `ADMIN_GEO_BYPASS_EMAILS` identity bypass —
  with all three lists shown read-only, since they're set via env vars, not
  the admin panel), and the email/push status panels.
- **Activity** — recent admin actions (viewer add/remove, role change, group
  save/delete, share
  create/bulk-create/extend/revoke/email/list-add/list-remove, video
  rename/delete/bulk-delete/reorder/collection change/watermark, watermark
  exemptions, settings, palette, collections), each with actor and time.
- **Analytics** — total views, 30-day views, watch time, video count, a 30-day
  views chart, a most-watched list, and a collapsible **per-video share
  analytics** panel rolling up existing share-link tracking.

---

## Email delivery of share links

When `RESEND_API_KEY` and `EMAIL_FROM` are set:

- Creating a share link (Videos tab → Share) emails the recipient automatically —
  a branded message with the video title, a watch button, the exact expiry, and a
  note that the link only works for their email address.
- The Shares tab shows an **Emailed** badge (with timestamp) per link and an
  **Email / Resend** button for links created before email was configured, failed
  sends, or lost emails.
- Email failures never lose the link: the admin sees the error, can copy the link
  manually, and can retry later. Sends are recorded in the activity log.

The sending domain must be verified in Resend or delivery will fail (the error
surfaces in the admin UI).

---

## Security notes

- **Access is by email identity.** Admin, approved-viewer, and share-recipient
  checks all compare the session's normalized email. Keep Auth0 **sign-ups
  disabled** (or require verified email) so nobody can self-register as an
  approved/admin address.
- **`/admin` is gated server-side** via `getServerSideProps`, and every
  `/api/admin/*` route independently returns `403` for non-admins.
- **Playback is always tokenized** — signed, time-limited embed URLs generated
  per request; no permanent public URL is used or exposed.
- **Share-link mismatches don't reveal** the intended recipient's email.
- **Authorization is capability-based and re-checked per route** — every
  `/api/admin/*` route independently requires its own capability, so a UI that
  renders a tab it shouldn't can never turn into an actual privilege.
- **Group scoping is enforced on the server**, including on the watch page,
  which 404s an out-of-scope video before minting an embed token — a video
  omitted from a list is not the same as a video the viewer can't reach.
- **Role resolution fails closed** and `ADMIN_EMAILS` resolves without touching
  Redis, so an infra failure can neither grant privileges nor lock the
  bootstrap admin out.
- **Optional `email_verified` enforcement** (`REQUIRE_VERIFIED_EMAIL`) refuses
  unverified sessions before any approval or role lookup. A missing claim counts
  as unverified.
- **Access requests grant nothing.** The request endpoint takes the address from
  the session (never the body), is rate-limited to 5/day, and only queues a
  record for an admin to act on.
- **Scheduled videos are unreachable by URL** outside their window, not merely
  hidden from the list — the watch page 404s before minting an embed token.
- **Thumbnails** are CDN-token-signed (when a token key is present) so they keep
  working with "Block Direct URL File Access" enabled.
- **Rate limiting** guards the video list, upload, share-creation, and broadcast
  endpoints (fails open if the limiter backend is unavailable).
- **Idle sign-out** logs users out after 30 minutes of inactivity.
- Direct bunny.net CDN file URLs are never used by the app; to lock them down
  fully, enable **Block Direct URL File Access** on the library's Security tab.
- **Email watermark** is a re-sharing deterrent, not DRM — it overlays the
  viewer's email on playback but does not prevent screen recording. Layered
  resolution (exemption → per-share → per-video → global default) is in
  `lib/watermark.js`.

---

## Common issues

- **Homepage shows a title list instead of thumbnails** — `BUNNY_CDN_HOSTNAME`
  isn't set (or the deploy hasn't picked it up). The grid appears once the API
  returns thumbnail URLs.
- **Thumbnails 403 directly but load in the app** — expected: that's
  referrer-based hotlink protection. Direct/off-site access is blocked.
- **Renaming the site doesn't change the PWA install name** — expected.
  `public/manifest.webmanifest` and the push-notification fallback title in
  `public/sw.js` are static files that can't read Redis, so the name shown on a
  home-screen icon still comes from those files and needs an edit + redeploy.
  Everything rendered by the app itself (header, page titles, share emails)
  follows the admin-set name immediately.
- **Share emails aren't sending** — confirm `RESEND_API_KEY` and `EMAIL_FROM` are
  set and picked up, and that the `EMAIL_FROM` domain is verified in Resend. The
  exact error appears in the admin UI when a send fails.
- **Login loops or "callback URL mismatch"** — the Auth0 app's Allowed Callback
  URLs must contain `https://your-domain/auth/callback` (v4 path), and
  `APP_BASE_URL` must match the exact production URL with no trailing slash.
- **Resume doesn't work** — the Bunny embed must expose the player.js protocol;
  playback still works either way. Check the console/network for `/api/progress`.
- **`npm install` fails on deploy** — usually a stray `package-lock.json` /
  `yarn.lock` committed alongside `package.json` (gitignored here on purpose), or
  a peer-dependency mismatch after a manual version bump.
- **Upload fails with HTTP 401** — a stray newline/space in `BUNNY_API_KEY` /
  `BUNNY_LIBRARY_ID` corrupts the TUS signature (the app trims them; re-paste
  cleanly in Vercel if it recurs).
- **"Redis client was initialized without url or token" / every admin tab fails**
  — with more than one storage database connected, Vercel prefixes the injected
  variable names with the store's name (e.g. `fablevideo_KV_REST_API_URL`). The
  app resolves any variable ending in the expected name, so redeploy after
  connecting the store; check Settings → Environment Variables to confirm.
- **Query Monitor panel doesn't show up** — `QUERY_MONITOR_ENABLED` only takes
  effect after a redeploy (it's a server-side env var), and the panel only
  renders for a *signed-in* user, on a page whose props include `user` — check
  `/api/monitor` directly: `404` means the flag isn't on for that deployment,
  `401` means you're not logged in.

---

## Scaling notes (Redis/Upstash)

A homepage visit costs a small, fixed number of Redis commands (viewer check,
homepage count, video order, last-seen, plus collections/progress reads). At
~1,000 visits/day this stays well under typical free-tier limits. Watch history
and the audit log add bounded writes. If traffic grows into the 10,000+
daily-visit range, move the rarely-changing settings (viewer list, count, order,
palette) to Vercel Edge Config to cut Redis load, leaving Redis for the TTL-based
share links and per-viewer progress.

---

## Continuous integration

Every push / PR to `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml):
**install → lint → test → build**, on Node 22. It mirrors the Vercel deploy
(fresh install, no lockfile), so a broken build fails the check before it ships.
Because there's no lockfile, a green local run and a red CI run usually mean a
freshly published dependency version. Consider enabling branch protection to
require the check on PRs.

---

## License

Private project — access by invitation only.
