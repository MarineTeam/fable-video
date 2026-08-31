---
name: architecture-contract
description: The load-bearing design decisions, invariants, and known weak points of the Marine Video Portal — WHY the identity/auth/caching/playback model is shaped the way it is. Load this BEFORE designing any change to auth, admin routes, sharing, video playback, Redis keys, or the bunny.net/video-list cache — i.e. whenever a task touches lib/auth.js, lib/guard.js, lib/redis.js, lib/store.js, lib/shares.js, lib/bunny.js, lib/videoList.js, lib/ratelimit.js, lib/audit.js, lib/email.js, proxy.js, pages/admin.js, or pages/watch/**, or when you need to know "why does it work this way" before touching it.
---

# Architecture contract — Marine Video Portal

This file is the mental model of the system: the invariants that must hold after your
change, the decisions that are load-bearing (don't "simplify" them away), and the weak
points the owner already knows about and has accepted. Read this BEFORE you design a
change to auth, admin routes, sharing, playback, or the Redis/bunny.net data layer.
This is a **design-time** reference — for the mechanics of gates/PR/merge, see
`change-control`; the two files cross-reference the same evidence but answer different
questions ("why is it built this way" vs. "what do I have to run before I merge").

Verified against `main` at commit `8dcb237` (`git log --oneline` — 12 commits, HEAD is the
merge of PR #2) on 2026-07-13. Re-verify anything you rely on; see "Provenance and
maintenance" at the end.

## When NOT to use this skill

| You are trying to... | Use instead |
|---|---|
| Know which gates to run / PR mechanics before editing a file | `change-control` |
| Respond to a CodeQL alert or suspected vulnerability | `security-response` |
| Bump a dependency or fix an install/peer-dependency failure | `dependency-currency` |
| Debug a runtime failure (500s, login loops, blank pages) | `debugging-playbook` |
| Understand a past incident or why a specific commit exists | `failure-archaeology` |
| Look up bunny.net/Auth0/Upstash/Resend API/field specifics | `domain-reference` |
| Add/change environment variables or config files | `environment-and-config` |
| Deploy, redeploy, or operate the running app | `run-and-operate` |
| Write or extend tests | `validation-and-qa` |
| Set up local tooling or diagnostics | `diagnostics-and-tooling` |
| Write README/CHANGELOG/docs prose | `docs-and-writing` |
| Plan and ship a whole feature end to end | `feature-shipping-campaign` |

Use **this** skill when you need to know what must stay true, and why, before you decide
how to make a change.

---

## 1. Numbered invariants

Each invariant: what must hold, why, where it's enforced, and a command to re-check it
right now. If your change would violate one of these, stop and reconsider the design —
don't just make the symptom go away.

### (a) Identity is normalized email, always — never compare raw session emails

**Statement:** Every access-control comparison in the app (admin check, approved-viewer
check, share-recipient check) goes through `normalizeEmail()` (trim + lowercase) from
`lib/auth.js`. Nothing compares `session.user.email` directly.

**Why:** Auth0 (and any human typing an email into the Viewers/Share UI) may hand back
mixed case or stray whitespace. Two different-looking strings for the same mailbox would
silently split one person into two identities — locking out a real viewer or, worse,
failing an admin check open by accident.

**Enforced at:** `lib/auth.js:4-8` (`normalizeEmail`), used by `lib/auth.js`
(`isEnvAdmin`), `lib/roles.js` (`resolveRole`/`resolveAccess`, which normalize
before every lookup), `lib/guard.js` (`sessionEmail`), and directly in
`pages/index.js:21`, `pages/admin.js:25`, `pages/watch/[shareId].js:14`,
`pages/watch/video/[id].js`, `pages/api/admin/viewers.js`, `pages/api/admin/share.js:27`.

**Verify with:** `grep -rln "normalizeEmail" lib pages` (expect `lib/auth.js`,
`lib/guard.js`, `pages/admin.js`, `pages/index.js`, `pages/watch/[shareId].js`,
`pages/watch/video/[id].js`, `pages/api/admin/share.js`, `pages/api/admin/viewers.js`) —
and `grep -rn "user.email ===" pages lib` should return **nothing** (raw comparison).

### (b) Every `/api/admin/*` route independently authorizes its own capability — the SSR gate on `/admin` is not sufficient alone

**Statement:** `pages/admin.js`'s `getServerSideProps` redirects anyone without a staff
role before any admin HTML ships, but that only protects the *page*. Every route file
under `pages/api/admin/` starts its handler with an independent, second check —
`const access = await requireCapability(req, res, CAP.X); if (!access) return;` (or
`requireAdmin`, which is `requireCapability(..., CAP.PEOPLE)`).

Since roles shipped, this is capability-based rather than a single admin bit: a route
declares what it needs (`CAP.VIDEOS`, `CAP.SHARES`, `CAP.PEOPLE`, `CAP.SETTINGS`,
`CAP.INSIGHTS`) and never tests for a role name. Which tabs `pages/admin.js` renders is
driven by the same capability list, but that is a *convenience* — hiding a tab is not
authorization, and a manager who hand-crafts a request to a `CAP.PEOPLE` route still
gets a 403 from the route itself.

**Why:** API routes are reachable directly (curl, browser devtools, a stale bookmark, a
future UI bug that calls an admin endpoint from a non-admin page) regardless of what the
`/admin` page itself renders. A single gate at the page level would mean any route bug or
direct API call bypasses authorization entirely.

**Enforced at:** `lib/guard.js` (`requireCapability`, `requireAdmin`, `requireAccess`);
called at the top of every file in `pages/api/admin/*.js`. The capability↔route mapping
lives in those route files' guard lines; `lib/capabilities.js` holds the role→capability
table.

**Verify with:** `grep -L "requireCapability\|requireAdmin" pages/api/admin/*.js` (expect
**no output** — every file matches). Note the one deliberate exception inside
`viewers.js`: `GET ?scope=recipients` authorizes `CAP.SHARES` instead of `CAP.PEOPLE`,
returning ONLY `{email, tags}` so a manager can resolve a group into share recipients
without gaining people-management access. If you widen what that projection returns, it
must move back behind `CAP.PEOPLE`.

### (c) Viewer approval fails CLOSED; rate limiting fails OPEN — the asymmetry is deliberate

**Statement:** `requireApproved` (`lib/guard.js:22-39`) treats a Redis error while
checking `isApprovedViewer` as **not approved** (`catch { approved = false; }`,
`lib/guard.js:29-32`) — access is denied on infra failure. `allowRequest`
(`lib/ratelimit.js:23-30`) treats a Redis error as **allowed** (`catch { return true; }`,
`lib/ratelimit.js:27-29`) — the request goes through on infra failure. `isAdmin(email)`
short-circuits `requireApproved` before the Redis lookup happens at all
(`lib/guard.js:25`: `if (isAdmin(email)) return email;`), so an env-var admin is never
subject to the fail-closed approval check.

**Why:** These are opposite failure modes for a reason. If approval failed *open*, a
Redis outage would expose the private video library to anyone who could log in via
Auth0 — a data leak. If rate limiting failed *closed*, a Redis outage would lock out every
real user from every rate-limited endpoint (video list, upload, share creation) — a
total, self-inflicted outage over an unrelated infra hiccup. Never flip either direction.

Role and group resolution follow the approval side of that asymmetry.
`resolveAccess()` (`lib/roles.js`) returns the least-privileged result — not approved,
no capabilities, empty video scope — on any Redis error, and a viewer whose *group*
scope can't be resolved gets an empty scope (sees nothing) rather than a null one (sees
everything). The distinction between `videoScope === null` (unrestricted) and
`videoScope === []` (nothing permitted) is load-bearing: `scopeAllows` treats them
oppositely, so never "normalize" an empty scope to null.

`ADMIN_EMAILS` addresses short-circuit `resolveAccess` before any Redis call at all, so
the bootstrap admin is never locked out by an infra failure — the same property
`isAdmin()` had before roles existed.

**Enforced at:** `lib/guard.js`, `lib/ratelimit.js:23-30`, `lib/roles.js`
(`resolveAccess`), `lib/capabilities.js` (`scopeAllows`).

**Verify with:** `sed -n '22,39p' lib/guard.js` and `sed -n '23,30p' lib/ratelimit.js` —
confirm the `catch` blocks resolve to `false` and `true` respectively.

### (d) Playback is ONLY via signed, time-limited embed URLs — direct CDN file URLs never appear anywhere

**Statement:** Every video play goes through `signEmbedUrl(videoId)`
(`lib/bunny.js:147-154`), which mints a fresh `https://iframe.mediadelivery.net/embed/...`
URL with a SHA256 token and a Unix `expires` timestamp, generated per request and never
stored. The app never constructs or exposes a direct `*.b-cdn.net/.../playlist.m3u8` or
`play_720p.mp4` URL.

**Why:** This is the core security property of the whole app — "private, invite-only
video." A direct CDN file URL, if it ever leaked into a log, a client bundle, or a
database record, would be a permanent, unauthenticated, shareable bypass of every access
check in the system. A signed embed token expires (`ttlSeconds = 3 * 3600` = 3h default)
and is scoped to one video.

**Enforced at:** `lib/bunny.js:1-4` (file-header invariant statement),
`lib/bunny.js:147-154` (`signEmbedUrl`); called from `pages/watch/[shareId].js:50` and
`pages/watch/video/[id].js`. Thumbnails follow the same pattern via `thumbnailUrl()`
(`lib/bunny.js:179-195`, token-signed when `BUNNY_CDN_TOKEN_KEY`/`BUNNY_TOKEN_AUTH_KEY`
is set).

**Verify with:** `grep -rn "b-cdn.net" pages lib` (expect no hardcoded direct file URLs —
only the CDN *hostname* via `cdnHostname()` composed into `thumbnailUrl`, never a raw
`.mp4`/`.m3u8` path) and `grep -n "signEmbedUrl" lib/bunny.js pages/watch/**/*.js`.

### (e) Every Redis key goes through `k()` — the `"fablevideo:"` namespace

**Statement:** No code hand-builds a Redis key string. Every read/write goes through
`k(...parts)` from `lib/redis.js:7-9`, which joins `["fablevideo", ...parts]` with `:`.

**Why:** The prefix is the entire migration mechanism. When the prefix changed from
`pvp:` to `fablevideo:` in commit `c37919e`, it was a one-line change in exactly one
place (`lib/redis.js`) precisely because every caller goes through `k()`. A hand-built
key string anywhere would (a) not have picked up that rename and (b) silently create an
orphaned, unprefixed key today.

**Enforced at:** `lib/redis.js:3-9`; used by every Redis-touching module —
`lib/store.js`, `lib/shares.js`, `lib/audit.js`, `lib/ratelimit.js:16`
(`prefix: k("rl", name)`).

**Verify with:** `grep -rn 'redis()\.' lib | grep -v 'k("'` should turn up nothing that
passes a literal string instead of a `k(...)` call as the key argument; spot check with
`grep -n 'k("' lib/store.js lib/shares.js lib/audit.js`.

### (f) Every bunny.net mutation must invalidate the video-list cache

**Statement:** `createVideo`, `updateVideo`, and `deleteVideo` in `lib/bunny.js` each call
`invalidateVideoListCache()` (`lib/bunny.js:50-52`) immediately after their API call —
`createVideo` at line 97, `updateVideo` at line 106, `deleteVideo` at line 112. Any *new*
bunny.net mutation you add (e.g., a bulk-delete, a future "duplicate video" action) must
do the same.

**Why:** `listAllVideos()` (`lib/bunny.js:77-88`) caches the full library for
`VIDEO_LIST_CACHE_TTL_MS = 4000` (4 seconds, `lib/bunny.js:47`) per warm serverless
instance, because the homepage, search, filters, and pagination all read through it and
re-fetching bunny.net's whole library on every keystroke would be slow and wasteful. A
mutation that forgets to invalidate this cache serves **stale data for up to 4 seconds on
that instance** — e.g., an admin deletes a video and it's still visible/playable to
viewers hitting the same warm instance for up to 4s.

**Enforced at:** `lib/bunny.js:50-52` (definition), call sites at `lib/bunny.js:97, 106,
112`.

**Verify with:** `grep -n invalidateVideoListCache lib/bunny.js` (expect the definition
plus exactly 3 call sites today — if you add a 4th mutation, this count should go to 4).

### (g) Share-link mismatch responses never reveal the intended recipient

**Statement:** In `pages/watch/[shareId].js`, if a logged-in user opens a share link
whose recorded `email` doesn't match their own normalized session email, the page renders
a generic `"This link was made for someone else"` message (`state: "mismatch"`,
`pages/watch/[shareId].js:34-37`) — it never displays or leaks whose link it actually is.
A dead/expired/nonexistent share ID renders an equally generic `"gone"` state
(lines 31-33), indistinguishable from a mismatch in terms of what's revealed.

**Why:** If the mismatch page showed the intended recipient's email, any logged-in user
who guessed or found a share ID (they're 16-64 char random base64url strings, see
`isShareId`, `lib/shares.js:13-15`, so guessing is impractical — but the response still
shouldn't help) could harvest email addresses of people the admin shared videos with.

**Enforced at:** `pages/watch/[shareId].js:31-37`.

**Verify with:** `sed -n '25,37p' pages/watch/\[shareId\].js` — confirm neither the
`"gone"` nor `"mismatch"` prop payload includes `share.email` or `share.videoTitle`.

**Extended to bundles:** `pages/watch/bundle/[bundleId].js` mirrors this exactly —
`bundle.email` mismatch or a missing bundle both render the same generic
`ShareGateMessage` copy (shared component, `components/ShareGateMessage.js`, used by both
pages so the two privacy guarantees can't drift independently), never the bundle's
recipient email or any item's title. A bundle is a pure list of share ids
(`lib/bundles.js`) — its own gate is a second, independent check of this invariant, not a
derivation of the individual share checks.

### (h) Every API catch block logs `console.error` before returning a generic 5xx

**Statement:** Every `catch` in every `pages/api/**` route logs the real error via
`console.error("label:", err)` before responding with a generic error status.

**Why:** Before commit `1e01860`, data-layer failures were swallowed silently and
surfaced only as an opaque `502` — a Redis misconfiguration was undiagnosable from
Vercel's logs. Every catch block must leave a trail in the server logs even though the
HTTP response stays generic (so as not to leak internals to the client).

**Enforced at:** commit `1e01860`; pattern present in every `pages/api/**` file, e.g.
`pages/api/admin/share.js:41,55` (`console.error("Video not found:", err)`,
`console.error("Could not create the share link:", err)`).

**Verify with:**
`grep -c "console.error" pages/api/admin/*.js pages/api/*.js | grep ":0"` (expect **no
output** — every API file has at least one `console.error`).

### (i) Email delivery is inert-until-configured, and failures never lose the share link

**Statement:** `emailEnabled()` (`lib/email.js:10-12`) is `true` only when both
`RESEND_API_KEY` and `EMAIL_FROM` are set. Share-link *creation* (`createShare`,
`lib/shares.js:23-41`) never depends on email succeeding — `pages/api/admin/share.js`
creates the share record first (lines 45-57), then attempts email only if
`shouldEmail && emailEnabled()` (line 65), and an email failure is caught and returned as
`emailError` in the response (lines 74-77) without failing the whole request. The share
and its URL always exist regardless of email outcome.

**Why:** Resend is optional infrastructure (per README, "Without these, everything still
works — admins copy share links and send them manually"). Coupling share creation to
email success would mean a Resend outage or a misconfigured sending domain blocks the
core sharing feature entirely, not just the delivery convenience.

**Enforced at:** `lib/email.js:10-12` (`emailEnabled`), `pages/api/admin/share.js:45-78`
(create-then-optionally-email ordering).

**Verify with:** `sed -n '45,78p' pages/api/admin/share.js` — confirm `createShare` is
awaited and its result used to build the response regardless of the `emailEnabled()`
branch's outcome.

### (j) Audit logging is best-effort and must never break the underlying action

**Statement:** `logAction()` (`lib/audit.js:7-18`) wraps its Redis writes in a
`try/catch` that swallows failures silently (`lib/audit.js:15-17`, comment: "Best-effort
by design"). No caller `await`s a failure path from `logAction` as a reason to abort or
fail its own mutation.

**Why:** The Activity tab is a convenience audit trail, not the source of truth for the
mutation itself (bunny.net or Redis is). If logging an action could itself fail the
action, a Redis hiccup during, say, a video delete would leave the admin unsure whether
the delete happened — the tail must never wag the dog.

**Enforced at:** `lib/audit.js:7-18`.

**Verify with:** `sed -n '7,18p' lib/audit.js` — confirm the `catch` block has no
`throw`/`return error` and every mutating `pages/api/admin/*` route calls `logAction`
*after* its main action succeeds, not as a precondition (`grep -n logAction
pages/api/admin/share.js` → line 80, after the share and email logic above it).

### (k) The service worker caches ONLY a fixed allowlist of immutable public static assets — never Auth0, `/api/*`, page navigations, or signed video/thumbnail URLs

**Statement:** `public/sw.js`'s `fetch` handler calls `event.respondWith(...)` **only** for
same-origin GET requests whose pathname is in the hardcoded `PRECACHE` allowlist
(`/manifest.webmanifest`, `/icon-192.png`, `/icon-512.png`, `/icon-maskable-512.png`,
`/apple-touch-icon.png`). Every other request — cross-origin (bunny.net embeds/thumbnails),
`/api/*`, `/auth/*`, and all page navigations — falls through to the network untouched (the
SW returns early, never caching or serving it).

**Why:** This app's entire security model depends on responses being short-lived and
per-viewer: video playback uses 3-hour signed bunny.net embed tokens (invariant (d)),
thumbnails are token-signed, every `/api/*` response is per-viewer data behind an Auth0
session, and `/auth/*` is the login flow. A service worker that cached any of these would
serve one viewer's private data (or a soon-expired signed URL) to another visitor on the
same device, or persist an authorization token past its TTL — a permanent, offline-readable
bypass of every access check. The allowlist exists so the PWA can be installable and load
its icons offline **without** the SW ever touching anything sensitive. This is the same
class of invariant as (d): the cache must never become a place a secret or private response
can leak from.

**Enforced at:** `public/sw.js:1-14` (file-header statement of the rule),
`public/sw.js:18-24` (the `PRECACHE` allowlist), `public/sw.js:83-108` (the `fetch` handler's
two early-return guards: `url.origin !== self.location.origin` and
`!PRECACHE.includes(url.pathname)` before any `respondWith`).

**Verify with:** `sed -n '83,108p' public/sw.js` — confirm both early returns precede the
single `event.respondWith(...)`, and that `PRECACHE` (`sed -n '18,24p' public/sw.js`) lists
only public, non-secret static assets. `grep -n "event.respondWith" public/sw.js` should show
exactly one call site (line 94; the header comment at line 13 also mentions the word).

### (l) Web Push sends only ever reach currently-approved viewers/admins, the new-video announce is atomic per video, and broadcast click targets are same-origin only

**Statement:** Three sub-invariants of the Web Push feature (`lib/push.js`), all
security-relevant: **(1)** `sendPushToApproved()` filters every subscription against the
*live* approved-viewer list plus `ADMIN_EMAILS` at send time (`lib/push.js:100-114`) — a
viewer removed from `/admin` stops receiving immediately, even though their subscription
record still sits in Redis until it's next pruned. **(2)** `maybeAnnounceReadyVideos()` gates
each new-video announcement on an atomic `SADD` (`lib/push.js:134-135`, `if (added === 1)`), so
when multiple concurrent serverless instances observe the same newly-ready video, exactly one
sends the notification — never zero, never duplicated. **(3)** the admin manual broadcast
(`pages/api/admin/notify.js`) forces the notification's click URL to a same-origin path
(`rawUrl.startsWith("/") ? rawUrl : "/"`) — an external click target is never accepted.

**Why:** Push subscriptions outlive approval — someone approved last month who was since
removed still has a live browser subscription. If sends were keyed off the stored
subscription list alone, a de-approved viewer would keep getting "new video" notifications
(a slow-motion data leak: titles of private videos). Filtering against the live viewer list
on every send closes that. The atomic-`SADD` guard exists because bunny.net can transition
several videos to "ready" between polls and the announce path runs inside `/api/admin/videos`
(invariant: best-effort, `lib/push.js` never throws into the request) on whichever warm
instance serves the admin — without the atomic guard, two instances would double-notify every
viewer. The same-origin click clamp prevents an admin (or a compromised admin request) from
crafting a notification that deep-links viewers to an attacker-controlled URL.

**Enforced at:** `lib/push.js:100-114` (`sendPushToApproved` live-viewer filter),
`lib/push.js:119-143` (`maybeAnnounceReadyVideos`, seed-on-first-run + atomic `SADD`),
`pages/api/admin/notify.js` (the `rawUrl.startsWith("/")` clamp, `requireAdmin`, 10/hour rate
limit, and `logAction(admin, "push.broadcast", ...)`). Removal is ownership-checked too:
`removePushSubscription(endpoint, email)` refuses to delete another user's subscription
(`lib/push.js:56-65`).

**Verify with:** `sed -n '100,143p' lib/push.js` — confirm the `allowed` set is built from
`listViewers()` + `adminEmails()` at call time (not a stored copy) and the announce loop
sends only when `SADD` returns `1`. `grep -n 'startsWith("/")' pages/api/admin/notify.js`
confirms the same-origin click clamp. All sends are inert unless `pushEnabled()` (both VAPID
vars set) — `grep -n "pushEnabled" lib/push.js pages/api/push/subscribe.js pages/api/admin/notify.js`.

---

### (m) Group video scoping is enforced on the SERVER at every read path — omission from a list is never the control

**Statement:** A viewer restricted by a group must be stopped by the server on every
path that can reach a video, not merely left out of the library listing:
`fetchVideoLibrary(videoScope)` (`lib/videoList.js`) filters before the homepage count is
applied, `/api/videos` and `/api/collections` pass the caller's scope, `/api/progress`
filters continue-watching, and `pages/watch/video/[id].js` returns `notFound` for an
out-of-scope id **before** `signEmbedUrl` is called. Share links are deliberately
exempt — a share is an explicit per-recipient grant that stands on its own, and
`pages/watch/[shareId].js` is unchanged.

**Why:** Same class as (d). The video id is in the URL; a viewer who learns one another
way (an old bookmark, a forwarded link, a previously-visible video that was later
restricted) must not be able to play it. If scoping lived only in the list query, the
watch page would happily mint a signed 3-hour embed token for any id an unrestricted-
looking session asked for — a complete bypass of the restriction. The 404 (rather than
403) also keeps a restricted viewer from probing which ids exist.

**Extended to schedules:** `lib/schedule.js`'s publish/expiry window is enforced at
exactly the same points and for the same reason — `lib/videoList.js`,
`pages/api/progress.js`, and a `notFound` in `pages/watch/video/[id].js` before
`signEmbedUrl`. Two differences, both deliberate: staff are exempt (an admin must be
able to find and preview an unpublished video, which the Scheduled/Expired badges
support), and a schedule READ failure fails **open** (no constraint) rather than closed.
That asymmetry against group scope is intentional: a group decides what someone is
entitled to, so an unreadable answer must deny; a schedule only decides *when* already
entitled content appears, so an unreadable answer must not take the whole library off
the air.

**Enforced at:** `lib/groups.js` (`resolveScope`/`allowedVideoIds`), `lib/roles.js`
(`resolveAccess` computes `videoScope`, and never scopes staff), `lib/schedule.js`
(`isLive`), `lib/videoList.js`, `pages/api/videos.js`, `pages/api/collections.js`,
`pages/api/progress.js`, `pages/watch/video/[id].js`.

**Verify with:** `grep -rn "videoScope\|scopeAllows" pages lib | grep -v __tests__` —
every viewer-facing read path should appear. `grep -n "scopeAllows" "pages/watch/video/[id].js"`
must show the check ABOVE the `signEmbedUrl` call in the same file.

**Restriction semantics that must not drift** (tested in `lib/__tests__/groups.test.js`):
a tag with no group record is a plain label; an unrestricted group is a plain label; a
member of several groups gets the UNION of the restricted ones, and an unrestricted group
never widens a restricted one back to the full library. That last one is the security
property — if it inverts, any stray extra tag silently defeats every restriction.

---

### (n) An unapproved session may reach exactly one endpoint, and it grants nothing

**Statement:** `/api/access-request` is the only authenticated route that deliberately
uses `requireUser` (logged in) rather than `requireAccess` (approved) — an unapproved
person has to be able to call it, or the feature can't work. It compensates in three
ways that must all stay: the email comes from the **session**, never `req.body`; it is
rate-limited (5/day); and it only writes a queue record. Granting happens solely in
`/api/admin/access-requests` behind `CAP.PEOPLE`.

**Why:** This is the one place the "everything behind approval" rule is relaxed, so it
is the one place a mistake widens the attack surface. Taking the address from the body
would let any signed-in person flood the admin queue with other people's addresses
(and make the queue's provenance meaningless). Skipping the rate limit would make it a
free write amplifier against Redis.

**Related — `REQUIRE_VERIFIED_EMAIL` (`blockedByEmailVerification`, `lib/auth.js`):**
when on, an unverified session is refused before any approval or role lookup. A
**missing** claim counts as unverified (a connection that doesn't send the field must
not silently disable the check), and `ADMIN_EMAILS` addresses are exempt — the same
recovery-path logic as their un-demotable role. The check is pure and Redis-free so the
API guard and every page gate share one implementation.

**Verify with:** `grep -n "requireUser\|requireAccess" pages/api/access-request.js`
(must be `requireUser`), `grep -n "req.body?.email" pages/api/access-request.js`
(expect **no output** — the address must not come from the body), and
`grep -rn "blockedByEmailVerification" lib pages` (the guard plus every page gate).

---

## 2. Load-bearing decisions (don't undo these without a deliberate call)

| Decision | Why it's load-bearing |
|---|---|
| **Pages Router, not App Router.** No `app/` directory exists anywhere in the repo (confirmed: `ls` at repo root shows no `app/`). | The entire codebase — `getServerSideProps` auth gates on `pages/index.js`, `pages/admin.js`, `pages/watch/[shareId].js`, the `pages/api/**` route-handler shape, `proxy.js`'s role as the Next 16 network boundary — assumes Pages Router conventions. Adding an `app/` directory would create two competing routing systems and likely double-mount or bypass the auth gates. Don't add one without a full migration plan (out of scope for a routine change). |
| **`proxy.js`'s broad matcher is required for rolling session refresh.** `config.matcher` excludes only `_next/static`, `_next/image`, `favicon.ico`, `sitemap.xml`, `robots.txt` (`proxy.js:11-15`) — everything else, including every page and every API route, passes through `auth0.middleware(request)`. | The inline comment states it directly: "the broad matcher is required for rolling sessions to refresh on ordinary page/API traffic" (`proxy.js:12-13`). Narrowing the matcher (e.g., to only `/admin` or only `/api/*`) would stop session cookies from refreshing on requests that don't hit it, causing sessions to expire mid-use on excluded routes. |
| **Shares are TTL-native, and "expired" is an app-level check (`isShareLive`), not the record's physical absence.** Since v1.13, every share lives as one field of a single Redis HASH (`k("shares")`, field = share id), using Redis 7.4's per-hash-field TTL (`HEXPIRE`/`HSETEX` family — Upstash supports these) instead of a physical TTL on its own standalone key (the pre-v1.13 shape: one STRING key per share plus a SET index — see `domain-reference` section 4's "Historical note"). `createShare(s)` sets each field's physical TTL to `ttlHours * 3600 + GRACE_SECONDS` (`lib/shares.js`, `GRACE_SECONDS = 30 days`), deliberately **longer** than the share's nominal `expiresAt`. Every recipient-facing read (the watch page, the bundle page, `share-track`) must call `isShareLive(share)` — `expiresAt` in the future **and** not revoked — instead of treating "the record exists" as "the link works"; `listShares()` and the admin Shares tab intentionally keep showing grace-window-expired and revoked records so they can be Extended/Restored. Revoke is a **soft, in-place flag** (`revokeShares` sets `revoked: true`, `HSETEX ... KEEPTTL`) — `isShareLive` treats a revoked share as dead immediately, but the record itself survives so `unrevokeShares` can restore it; only `permanentlyDeleteShares` (`HDEL`) actually removes a field. Patches that don't move `expiresAt` (view/playback stamps, `emailedAt`, revoke/unrevoke) always write with `KEEPTTL`, never a recomputed value — each field's own remaining TTL is preserved exactly by Redis itself, no `TTL` read-back needed. `extendShares` is the one path allowed to move `expiresAt` itself, always "from now," and refuses a revoked share explicitly (extending can never double as a silent un-revoke — restore it first). Every bulk admin action (revoke/unrevoke/delete/extend/resend, `pages/api/admin/shares.js` + `share-extend.js` + `share-email.js`) goes through a *batch* read (`getShares`, one `HMGET`) and a *batch* write (`writeShares`, one `HSETEX`/`HDEL`) for the whole selection — never a `Promise.all` of per-id Redis calls. | Before Extend existed, a share's physical Redis TTL *was* its expiry — the record simply vanished the instant it lapsed, which is why updates were always careful to preserve remaining TTL rather than reset it (that invariant still holds, unchanged, now via `KEEPTTL` instead of a `TTL`-then-`SET` round trip). Extend added a real requirement — "push an already-expired-but-not-revoked link back to live" — that's impossible if Redis has already hard-deleted the record; the grace window + app-level `isShareLive` fix is what makes that possible, and is unrelated to the v1.13 hash migration. The hash migration itself exists purely for Redis-command economy: Upstash bills a multi-key command (the old per-share `MGET`) per key touched, so listing 1000 shares cost ~1001 commands; a single-hash command (`HGETALL`/`HMGET`/`HSETEX`/`HDEL`) bills once regardless of field count, so the same load is now 1 command, and any bulk action on up to 100 ids is 2. Any new recipient-facing read path must still call `isShareLive`, not just check truthiness, and any new bulk admin action must go through `getShares`/`writeShares`, not a per-id loop — reintroducing a Promise.all of single-share Redis calls silently regresses the whole point of this design. |
| **The video list is cached for 4 seconds per warm serverless instance, and the homepage does an SSR-first-page fetch with client-side filtering after that.** `listAllVideos()` promise-caches for `VIDEO_LIST_CACHE_TTL_MS = 4000` (`lib/bunny.js:47,77-88`); `pages/index.js`'s `getServerSideProps` calls `fetchVideoLibrary()` server-side (lines 40-53) so the first paint already has data, and all search/collection-filter/pagination interaction after that happens client-side against the one fetched list (`pages/index.js:186-198`, no network round trip per keystroke — see file header comment lines 1-6). | This is what commit `68ee934` (homepage speedup) and `b9e2b22` (client-side search/filter/pagination) bought: no round trip per keystroke, and the homepage doesn't wait for hydration-then-fetch. The cost is invariant (f) above — every mutation must remember to invalidate — and known weak point below (per-instance cache disagreement). |
| **Settings, viewers, and video order live in Redis, not code or env vars, so admins never redeploy for day-to-day changes.** `lib/store.js` — `getSettings`/`saveSettings`, `getOrder`/`saveOrder`, `listViewers`/`addViewers`/`removeViewer`, `getTheme`/`saveTheme` all read/write Redis directly, with no caching layer and no env var involved. | This is explicitly why the admin panel (`pages/admin.js`) can change the homepage video count, reorder videos, add/remove approved viewers, and change the color palette live, with effects visible on the next request — no Vercel redeploy, unlike `ADMIN_EMAILS` (see weak point below) or any `RESEND_API_KEY`/`BUNNY_*` env var change. |

---

## 3. Known weak points (stated plainly, not sugar-coated)

| Weak point | Detail | What to do about it |
|---|---|---|
| **Orphaned `pvp:*` Redis keys.** | Commit `c37919e` (2026-07-09) renamed the key prefix from `pvp:` to `fablevideo:` in `lib/redis.js` with **no migration** — the commit message states this explicitly ("All data is stored fresh so there's no migration"). Any data written before that commit under the old prefix is invisible to the app today and will never be read or cleaned up by it. | If you ever need to account for "missing" historical data (viewers, shares, settings) from before 2026-07-09, check for a stray `pvp:*` keyspace in Redis directly — the app will never surface or clean it. Not an active problem, just a fact to know before debugging "where did old data go." |
| **Email claim is trusted; no `email_verified` enforcement in app code.** | `lib/auth.js` and `lib/guard.js` trust `session.user.email` as-is (after normalization) with no check of an `email_verified` claim from Auth0. `grep -rn email_verified` across `lib/` and `pages/` returns no hits outside `node_modules`. | Mitigated operationally, not in code: README "Security notes" (line ~204) and the one-time setup checklist (line 150) both instruct disabling Auth0 self-sign-up ("Disable Sign Ups") and adding people manually, so nobody can register an unverified address themselves. If that operational control is ever relaxed, this becomes a real gap — route to `security-response` if you're asked to harden it. |
| **Per-serverless-instance cache means instances can disagree for up to 4 seconds.** | `videoListCache` in `lib/bunny.js:48` is a module-level `let`, meaning each warm Vercel serverless instance has its own independent cache and its own independent 4-second clock. Two viewers hitting two different warm instances immediately after an admin mutation can see different library states for up to 4s, even though invariant (f) is fully respected. | This is accepted behavior for a 4-second window, not a bug to fix reflexively. If a future feature needs strict read-after-write consistency (e.g., a "confirm your video is live" admin flow), don't assume the cache is consistent — poll or bypass `listAllVideos()`. |
| **RESOLVED (roles release): admins are no longer env-var-only, and `ADMIN_EMAILS` is now a bootstrap seed.** | Roles (`viewer`/`manager`/`admin`) live in Redis (`k("roles")`) and are assigned from `/admin` → Viewers with no redeploy. `ADMIN_EMAILS` was deliberately **kept** rather than replaced: its addresses are admins unconditionally, resolve without any Redis call, and cannot be demoted through the UI. That asymmetry IS the feature — it is the recovery path if the roles hash is emptied or corrupted. This was an explicit, owner-approved decision to override the previous "don't add a Redis-backed admin list without discussion" guidance, taken with the recovery path and fail-closed resolution as the conditions. | "Add me as an admin" is now an admin-panel action. Two guardrails must stay: an admin cannot change their own role (self-lockout), and an `ADMIN_EMAILS` address's role cannot be changed from the UI (the write would be ignored by `resolveRole` anyway). Removing a viewer also clears their stored role — without that, "remove" would leave a manager with implicit access, since staff are approved without being on the viewer list. Do NOT remove the env seed to "simplify" — that deletes the only way back into a portal with broken role data. |
| **No lockfile means dependency drift can break a deploy or CI with zero code change.** | `.gitignore` blocks `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml` by design (doctrine: keep dependencies on latest versions within `package.json`'s caret ranges). A new patch/minor release of any dependency can change behavior or break the build between two otherwise-identical commits. | Not this skill's territory — route to `dependency-currency` for the latest-versions doctrine and the ESLint 9.x pinning exception (commit `f2d3a30`). |
| **Route coverage is limited to the authorization layer; pages have none.** | `routes.test.js` now drives real handlers (roles, groups, access requests) through `lib/__tests__/helpers/route.js` with Auth0 and Redis stubbed, asserting 401/403 boundaries, the verified-email gate, and the role/request guardrails. Everything else under `pages/api/**` — and all of `pages/*.js` — is still unexercised; `npm run lint` and `npm run build` are the only automated checks on it. | A passing `npm test` now says something about guard ordering and status codes on the covered routes, and still says nothing about the rest (bunny.net mutations, share flows, upload, page rendering). Extend `routes.test.js` when you touch a route's authorization; route to `validation-and-qa` for what else to add. |

---

## 4. Before you design anything — checklist

Walk this before writing code for any change touching auth, admin routes, sharing,
playback, or the data layer:

1. **Which invariant(s) from section 1 does this change touch?** If none, you may be in
   safer territory — but double-check against section 2's load-bearing decisions too.
2. **Does every comparison of "who is this user" go through `normalizeEmail()`?** (a)
3. **If this adds or touches a `/api/admin/*` route, does it start with
   `requireAdmin(req, res)` independently of any page-level gate?** (b)
4. **If this touches approval or rate-limiting, does it preserve fail-closed for approval
   and fail-open for rate limiting?** Never flip either. (c)
5. **Does this ever construct, log, or expose a direct bunny.net CDN file URL?** It must
   not — only `signEmbedUrl`/`thumbnailUrl` outputs. (d)
6. **Does this add a new Redis key anywhere?** It must go through `k(...)` from
   `lib/redis.js`, never a hand-built string. (e)
7. **Does this add a new bunny.net mutation (create/update/delete/anything that changes
   the library)?** It must call `invalidateVideoListCache()` after the API call. (f)
8. **Does this touch the share-mismatch or share-gone response paths?** Confirm no
   recipient/title leaks into a mismatch or expired response. (g)
9. **Does every new `catch` block in an API route log `console.error(...)` before
   returning its error status?** (h)
10. **If this touches email, does share/link creation still succeed and return usable
    data when email fails or isn't configured?** (i)
11. **If this adds an admin mutation, does it call `logAction(...)` after success, without
    letting a logging failure block the mutation?** (j)
12. **Does this touch `public/sw.js` or add anything the service worker could cache?** The
    `fetch` handler must keep responding only for the fixed same-origin `PRECACHE` allowlist
    of public static assets — never `/api/*`, `/auth/*`, page navigations, or signed
    bunny.net URLs. (k)
13. **Does this touch Web Push (`lib/push.js`, the subscribe/notify routes, the announce
    path)?** Sends must filter against the live approved-viewer list at send time, the
    new-video announce must stay atomic-per-video (`SADD` guard), broadcast click targets
    must stay same-origin, and the whole feature must stay inert when `pushEnabled()` is
    false. (l)
14. **Does this add or change an `/api/admin/*` route's guard?** It must declare a
    specific capability (`requireCapability(req, res, CAP.X)`), never test a role name,
    and never rely on the panel hiding the tab. (b)
15. **Does this add a path by which a viewer can reach a video?** It must consult
    `access.videoScope` via `scopeAllows` server-side, and must not confuse an empty
    scope (nothing permitted) with a null one (unrestricted). (m)
16. **Does this touch role resolution?** `ADMIN_EMAILS` must keep short-circuiting
    before any Redis call, resolution must keep failing closed, and self-role-change and
    env-admin demotion must stay blocked. (c, section 3)
17. **Am I about to let an unapproved session reach a new endpoint, or take an
    identity from a request body instead of the session?** Both need an explicit
    decision — see (n); today `/api/access-request` is the only such route.
18. **Am I about to add an `app/` directory, narrow `proxy.js`'s matcher, reset TTL on
    share updates, or move viewer/settings/order data out of Redis?** Any of these needs a
    deliberate, explicit decision — not an incidental side effect of an unrelated change.
    (Section 2)
19. **Is this change touching one of the weak points in section 3?** If so, treat it as
    an explicit design decision worth calling out in the PR description, not a silent fix
    or a silently-inherited risk.

---

## Provenance and maintenance

Written 2026-07-13 by re-reading every file cited above directly (not from the common
context alone) — `proxy.js`, `lib/auth.js`, `lib/guard.js`, `lib/redis.js`,
`lib/store.js`, `lib/shares.js`, `lib/bunny.js`, `lib/videoList.js`, `lib/ratelimit.js`,
`lib/audit.js`, `lib/email.js`, `pages/index.js`, `pages/admin.js`,
`pages/watch/[shareId].js`, `pages/api/admin/share.js`, `README.md`, and commit
`c37919e`'s diff. All file:line citations above were confirmed against the actual file
contents on that date. Facts below are volatile — re-verify before relying on them.

**Updated 2026-08-31 (access requests, verified email, schedules, route tests):**
invariant (m) extended to cover `lib/schedule.js` and to record why schedule reads fail
OPEN while group scope fails CLOSED; invariant (n) added for the one unapproved-reachable
endpoint and for `REQUIRE_VERIFIED_EMAIL`. Route-level coverage now exists for the
authorization layer (`lib/__tests__/routes.test.js`), so the "no route tests at all"
weak point in section 3 is narrower than it was — pages and business logic are still
uncovered.

**Updated 2026-08-30 (roles + groups):** invariant (b) is now capability-based rather
than a single admin bit; (c) gained the role/group fail-closed rules and the
`videoScope` null-vs-empty distinction; (m) added for server-side group scoping;
checklist items 14-16 added; the "admins are env-var-only" weak point is resolved and
rewritten as the `ADMIN_EMAILS`-as-bootstrap-seed decision, including the guardrails
that must not be removed. Verified by reading `lib/capabilities.js`, `lib/roles.js`,
`lib/groups.js`, `lib/guard.js`, every `pages/api/admin/*.js` guard line, and
`pages/watch/video/[id].js` on that date.

**Updated 2026-07-15 (v1.8.0 Web Push + v1.7.0 PWA):** added invariants (k) (service-worker
cache allowlist) and (l) (Web Push send-gating / atomic announce / same-origin click),
checklist items 12–13, and their provenance rows — verified by reading `public/sw.js`,
`lib/push.js`, `pages/api/admin/notify.js`, and `pages/api/push/subscribe.js` directly on
that date. Line numbers in (k)/(l) are against those files as of v1.8.0 and will drift.

| Volatile claim | Re-verify with |
|---|---|
| Every `/api/admin/*` route authorizes a capability | `grep -L "requireCapability\|requireAdmin" pages/api/admin/*.js` (expect no output) |
| Role→capability table and the three roles | `sed -n '1,60p' lib/capabilities.js` |
| Role resolution fails closed; env admins skip Redis | `npm test -- roles access` and read `resolveAccess` in `lib/roles.js` |
| Group scoping enforced on the watch page before token signing | `grep -n "scopeAllows" "pages/watch/video/[id].js"` (must precede `signEmbedUrl`) |
| `requireApproved` fails closed, `allowRequest` fails open | `sed -n '22,39p' lib/guard.js; sed -n '23,30p' lib/ratelimit.js` |
| No direct CDN file URLs anywhere | `grep -rn "b-cdn.net" pages lib` (expect only `cdnHostname()`-composed URLs, no raw `.mp4`/`.m3u8`) |
| Every Redis key goes through `k()` | `grep -rn 'redis()\.' lib` then eyeball each key argument is `k(...)` |
| bunny mutations invalidate cache — currently 3 call sites | `grep -n invalidateVideoListCache lib/bunny.js` |
| Share mismatch/gone responses leak nothing | `sed -n '25,37p' "pages/watch/[shareId].js"` |
| Every API catch logs before its 5xx | `grep -c "console.error" pages/api/admin/*.js pages/api/*.js \| grep ":0"` (expect no output) |
| Email failures don't block share creation | `sed -n '45,78p' pages/api/admin/share.js` |
| `logAction` failures are swallowed, not propagated | `sed -n '7,18p' lib/audit.js` |
| No `app/` directory exists | `ls /home/user/fable-video \| grep -x app` (expect no output) |
| `proxy.js` matcher still broad | `sed -n '10,16p' proxy.js` |
| Share TTL preserved on update (now via HSETEX KEEPTTL, not a TTL-then-SET round trip) | `grep -n "keepttl: true" lib/shares.js` |
| Shares live in one hash (`k("shares")`), not one key per share; bulk admin actions batch through `getShares`/`writeShares` | `grep -n "sharesKey\|export async function.*Shares(" lib/shares.js` |
| Video-list cache TTL and per-instance scope | `grep -n "VIDEO_LIST_CACHE_TTL_MS\|let videoListCache" lib/bunny.js` |
| `pvp:*` keys were never migrated | `git show c37919e --stat` and read the commit message |
| `ADMIN_EMAILS` is still an un-demotable seed, not the only admin source | `grep -n "isEnvAdmin" lib/auth.js lib/roles.js`; `grep -n "ADMIN_EMAILS" pages/api/admin/roles.js` |
| Test coverage still limited to `lib/__tests__/` (though `access.test.js` now covers the resolver with Redis stubbed) | `ls lib/__tests__/`; `grep -rL "test(" pages/api/**/*.js 2>/dev/null \| wc -l` (all of them, since none have tests) |
| SW caches only the `PRECACHE` allowlist, one `respondWith` (k) | `sed -n '83,108p' public/sw.js`; `grep -n "event.respondWith" public/sw.js` (expect exactly one call) |
| Push sends filter live viewers; announce is atomic; click is same-origin (l) | `sed -n '100,143p' lib/push.js`; `grep -n 'startsWith("/")' pages/api/admin/notify.js` |
| Lint/test/build baselines | see `change-control`'s Provenance table — same repo, same date |
