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
`requireAdmin`, which is `requireCapability(..., CAP.VIEWERS_MANAGE)`).

Since roles shipped, this is capability-based rather than a single admin bit: a route
declares what it needs (`CAP.VIDEOS_READ`, `CAP.VIDEOS_MANAGE`, `CAP.SHARES_READ`,
`CAP.VIEWERS_MANAGE`, `CAP.SETTINGS_MANAGE`, `CAP.ROLES_MANAGE`, ...) and never tests
for a role name — since roles became admin-defined there IS no role name to test for.
Routes that both list and mutate split by method: `GET` needs the `*_READ` half,
everything else the `*_MANAGE` half. Which tabs `pages/admin.js` renders is
driven by the same capability list, but that is a *convenience* — hiding a tab is not
authorization, and someone who hand-crafts a request to a `CAP.VIEWERS_MANAGE` route
without that capability still gets a 403 from the route itself.

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
`viewers.js`: `GET ?scope=recipients` authorizes `CAP.SHARES_MANAGE` instead of
`CAP.VIEWERS_MANAGE`, returning ONLY `{email, tags}` so a share manager can resolve a group into share recipients
without gaining people-management access. If you widen what that projection returns, it
must move back behind `CAP.VIEWERS_MANAGE`.

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

**AMENDED 2026-09-13 — see invariant (s).** The podcast feed's media route may 302 to a
pull-zone-signed, 15-minute MP4 URL, because podcast apps cannot render an iframe. That
is the ONLY exception, the URL never appears in any document or store, and it is minted
only after a full authorization re-check. Every other playback path is unchanged.

**Verify with:** `grep -rn "b-cdn.net" pages lib` (expect no hardcoded direct file URLs —
only the CDN *hostname* via `cdnHostname()` composed into `thumbnailUrl` and
`lib/bunnyMedia.js`, never a raw `.mp4`/`.m3u8` path in a stored or rendered value) and
`grep -n "signEmbedUrl" lib/bunny.js pages/watch/**/*.js`.

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

### (k) The service worker caches ONLY a fixed allowlist of public, non-secret, same-for-everyone assets — never Auth0, `/api/*`, page navigations, or signed video/thumbnail URLs

**Statement:** `public/sw.js`'s `fetch` handler calls `event.respondWith(...)` **only** for
same-origin GET requests whose pathname is in the hardcoded `PRECACHE` allowlist
(`/manifest.webmanifest`, `/icon-192.png`, `/icon-512.png`, `/icon-maskable-512.png`,
`/apple-touch-icon.png`). Every other request — cross-origin (bunny.net embeds/thumbnails),
`/api/*`, `/auth/*`, and all page navigations — falls through to the network untouched (the
SW returns early, never caching or serving it).

**Updated (site-name work):** `/manifest.webmanifest` is no longer a static file —
`next.config.js` rewrites it to `pages/api/manifest.js`, which generates it per-request from
the admin-set site name (Redis), so the SW is now caching a response whose *content* can
change. The allowlist's safety property is about WHO the content is for, not whether it's
literally immutable: `/api/manifest` is public (no auth, matches `proxy.js`'s matcher
exclusion), takes no per-request input, and returns the identical document to every
caller — nothing here is user-specific or session-scoped, so this stays outside the class
of thing invariant (k) exists to prevent. The SW's existing cache-first-then-refresh
strategy (`sed -n '90,116p' public/sw.js`) already re-fetches on every visit and updates
the cache in the background, so it needs no code change to keep working for a value that
now varies — a rename just takes one more visit to reach the cache, the same way an icon
change would.

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

**Enforced at:** `public/sw.js:1-16` (file-header statement of the rule),
`public/sw.js:26-32` (the `PRECACHE` allowlist), `public/sw.js:90-116` (the `fetch`
handler's two early-return guards: `url.origin !== self.location.origin` and
`!PRECACHE.includes(url.pathname)` before any `respondWith`). The dynamic manifest itself:
`pages/api/manifest.js` (no auth guard, by design — see its own header comment) and the
`beforeFiles` rewrite in `next.config.js`.

**Verify with:** `sed -n '90,116p' public/sw.js` — confirm both early returns precede the
single `event.respondWith(...)`, and that `PRECACHE` (`sed -n '26,32p' public/sw.js`) lists
only public, non-secret, same-for-everyone assets. `grep -n "event.respondWith" public/sw.js`
should show exactly one call site. Line numbers drift with comment edits — re-grep rather
than trust the numbers above if this file has changed since 2026-09-03.

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

**Upload-time grants (2026-09-23).** `/api/admin/upload` accepts `groupIds` and adds the
new video to those groups' allowlists. It is gated on `CAP.GROUPS_MANAGE` in addition to
`CAP.VIDEOS_UPLOAD` — they are separate capabilities under custom roles, and ticking a
box must not hand an uploader the power to grant access. Every refusal (no capability,
unknown group, group at `MAX_VIDEOS_PER_GROUP`) happens BEFORE `createVideo`, so none
leaves an orphan video; `grantVideoToGroups` never recreates a deleted group or lets
`saveGroup` silently truncate a full one, and reports per-group failure. Cancelling an
upload (`DELETE /api/admin/upload`) calls `pruneVideoFromGroups`. No stored default
group, by design. Verify: `npm test -- uploadRoute uploadGrants groupGrants`.

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
`/api/admin/access-requests` behind `CAP.VIEWERS_READ` (GET) and `CAP.VIEWERS_MANAGE`.

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

### (o) Per-video decoration is additive and never load-bearing — chapters and notes decide nothing about access

**Statement:** `lib/videoMeta.js` stores chapters (`k("chapters")`) and sermon notes
(`k("notes")`), one hash each, video id -> value. Absence of a row means no chapters
and no notes and behaviour identical to before those features existed — the same
shape `lib/schedule.js` uses for "no window". Neither hash is ever consulted to decide
whether someone may see or play a video, and every read of either is wrapped so a
failure costs the decoration and nothing else (`lib/videoList.js`, the admin
`GET /api/admin/videos`, and the `gssp` in `pages/watch/video/[id].js` all
`.catch()` into an empty value rather than propagating).

Notes ride along in the `/api/videos` payload so the existing client-side search can
match them. That search (`videoMatchesQuery`, `lib/notes.js`) is a pure predicate over
the list the server already built — it only ever NARROWS that list. It cannot widen it,
because it never consults anything outside the video object it was handed, and the
list it runs over has already been through group scope and schedule filtering
server-side.

**Why:** Two distinct failure modes this shape rules out. First, the additive default:
a decoration feature whose absence changed behaviour would, on the deploy that
introduced it, look exactly like an outage (see also invariant (m) and the same
reasoning in `lib/schedule.js`). Second, the search: if notes were matched by asking
the server "which videos mention X", that query would become a second, parallel path
to the library needing its own scope and schedule enforcement — a path any future
change would have to re-reason about. Filtering client-side over an
already-authorized list means there is exactly one place that decides what a viewer
may see, and it stays `lib/videoList.js`.

**Pure/storage split, again:** `lib/chapters.js` and `lib/notes.js` import no Redis.
They are reached from the browser (the watch page renders the chapter list; the
homepage runs the search predicate), and importing `lib/redis.js` from client-reachable
code pulls `async_hooks` in via `lib/monitor.js` and fails the build. This is the third
instance of the same split — `lib/capabilities.js` vs `lib/roles.js`,
`lib/siteName.js` vs `lib/store.js`, and now these vs `lib/videoMeta.js`. Treat it as
the house pattern, not a one-off.

**Enforced at:** `lib/chapters.js`, `lib/notes.js` (both pure), `lib/videoMeta.js`
(all storage), `lib/videoList.js` (the `getNotesMap().catch(() => ({}))` line),
`pages/watch/video/[id].js` (the chapters/notes read is after every access check and
inside its own try/catch), `pages/api/admin/videos.js` (the `set-chapters` /
`set-notes` actions, both behind `CAP.VIDEOS_MANAGE`).

**Verify with:** `grep -n "^import" lib/chapters.js lib/notes.js` (expect **no output** —
both modules import nothing at all; a `redis` mention in a comment is not an import);
`grep -n "getChapters\|getNotes" "pages/watch/video/[id].js"` — confirm both appear
AFTER `scopeAllows` and the schedule check.

### (p) A notification addressed to a subset never goes out via the broadcast sender

**Statement:** `sendPushToApproved()` reaches every currently-approved viewer and is
correct only for content everyone is entitled to ("a new video is ready").
`sendPushToEmails(emails, payload)` (`lib/push.js`) is the addressed sender, and is
what `lib/accessRequestNotify.js` uses. Recipients there are derived from
`emailsHoldingCapability(CAP.VIEWERS_MANAGE)` (`lib/roles.js`) — from the live role data, not
a hardcoded "admins" list. The whole notification is best-effort and
inert-until-configured: no Resend key means no email, no VAPID keys mean no push,
neither means no errors, and every path is wrapped so a delivery failure cannot fail
the access request it describes.

**Why:** Broadcasting an access request would tell every approved viewer that a named
stranger asked to join — the request, the requester's address, and the fact that they
are not yet approved, to an audience with no reason to know any of it. Deriving
recipients from the capability rather than a role name means that if `CAP.VIEWERS_MANAGE`
ever moves between roles, the recipients move with it instead of silently going to the
wrong people. And the best-effort wrapping is the same rule as invariant (j): the tail
must never wag the dog — a person's request for access must be recorded whether or not
anyone's mail server is up.

The requester's note is free text typed by a signed-in stranger. It is clamped and
control-stripped at the source (`lib/accessRequests.js`), HTML-escaped again in the
email template, and deliberately kept OUT of the push body — a push renders on a lock
screen readable by anyone holding the phone. There is also no approve-by-link: a link
that grants access from an inbox grants it to whoever else can read that inbox.

**Enforced at:** `lib/push.js` (`sendPushToEmails`, and the comment on it saying why it
is not a variant of `sendPushToApproved`), `lib/roles.js` (`capabilityHolders`),
`lib/accessRequestNotify.js`, `lib/email.js` (`accessRequestEmailTemplate`),
`pages/api/access-request.js` (the try/catch around the call).

**Verify with:** `grep -n "sendPushToApproved\|sendPushToEmails" lib/accessRequestNotify.js`
(expect only `sendPushToEmails`); `npm test -- accessRequestNotify` — the suite pins the
addressed-not-broadcast property, the inert-until-configured paths, and that every
delivery failure is swallowed.

---

### (q) Exactly one route serves video without a session, and it is default-deny and fails CLOSED

**Statement:** `pages/watch/public/[id].js` is the only path in the app that returns
video to a caller with no Auth0 session. A video reaches it only when a row exists for
it in `k("public")` — written solely by `pages/api/admin/public-videos.js`, which
authorizes **`CAP.SETTINGS_MANAGE`**, not the `videos.*` capabilities that ordinary library work needs. The
flag is never inferred: `isPublicVideo` returns true for one reason and returns
**false on absence, on a blank id, and on any Redis error**.

That last clause inverts this repo's usual polarity and is deliberate.
`lib/schedule.js` fails OPEN because a schedule decides *when* already-entitled people
see content, so an unreadable one must not take the library off the air. This flag
decides whether *the whole internet* sees a video, so an unreadable one must not
publish it. A public link briefly 404ing during a Redis outage is a smaller harm than
the library being published during one. The publish-window check on the public page
follows the same inverted rule for the same reason, even though the signed-in watch
page's copy of that check fails open.

**Why a separate page rather than a branch:** every other viewer-facing path
(`pages/index.js`, `pages/api/videos.js`, `pages/api/collections.js`,
`pages/watch/video/[id].js`) is an invite-only gate. An "…or the video is public"
branch in any of them would mean every future change to those files had to
re-reason about the anonymous case. One file means one file to audit when asking
"what can someone with no account reach?".

**What the public page still enforces, and what it deliberately drops:** it keeps the
publish/expiry window, a fresh signed time-limited embed token (invariant (d) is
untouched — "public" means no login, never an unsigned or permanent URL), and the geo
whitelist by construction, since `proxy.js` enforces that at the network boundary for
every matched route. It drops the watermark (there is no identity to stamp), and every
per-viewer key — no progress, no last-seen, no push. It uses a bare `<iframe>` rather
than `ResumablePlayer` *because* that wrapper posts to `/api/progress`: the surest way
not to track an anonymous visitor is not to ship the code that would. Groups are not
consulted, correctly — a group narrows a *viewer's* access and a public visitor is not
a viewer. The page sends `noindex, nofollow`: "no login required" is not "list me in
search results".

**Enforced at:** `lib/publicVideos.js` (the flag and its fail-closed read),
`pages/watch/public/[id].js` (the only anonymous video path),
`pages/api/admin/public-videos.js` (`CAP.SETTINGS_MANAGE`), plus the prune alongside the
order/group/schedule/meta prunes in `pages/api/admin/videos.js` — a stale row would
let a recycled bunny.net id inherit a public grant.

**Verify with:** `npm test -- publicVideos publicRoute`. `grep -rn "isPublicVideo" pages lib`
should show the definition plus exactly ONE caller (the public page) — a second caller
means the flag has escaped its one route.

### (r) A feed token is an identity claim, never an entitlement

**Statement:** The podcast feed authenticates with a 256-bit random token
(`lib/feedTokens.js`) instead of a session, because podcast apps cannot log in. The
token answers exactly one question — *which account is asking* — and nothing else.
Approval, role, group video scope and publish windows are re-resolved from Redis on
**every** feed poll and **every** episode download, via `resolveFeedRequest`
(`lib/feedAccess.js`) and the same `fetchVideoLibrary(access.videoScope)` the website
uses. No entitlement is encoded in the token, cached beside it, or remembered between
polls.

**Why this shape:** it is what makes the feature safe to have at all. Because nothing
is cached, removing someone from the viewer list, restricting their group, or expiring
a video ends the corresponding access on their app's next poll — with no revocation
step to remember and no stale grant to go looking for. A design that checked
entitlement once at subscribe time would need a revocation path, and revocation paths
are where this class of feature leaks. Token rotation exists for the *other* problem —
a leaked URL — and deletes the old token row so the old address stops resolving.

**Reuse is the security property, not an optimization:** the feed builds its episode
list from `fetchVideoLibrary`, the same function the homepage and `/api/videos` call,
precisely so group scoping and the publish window cannot drift between the website and
the feed. A feed that assembled its own list would be a second authorization path.

Denials are uniform: unknown token, malformed token, unapproved account, and
feature-disabled all answer an identical `404`. A feed URL is a bearer string that gets
pasted into apps and synced between devices; the response to a wrong one must not
distinguish "no such token" from "that person is no longer approved".

**Enforced at:** `lib/feedTokens.js` (256-bit generation, shape check before any Redis
lookup, fail-closed resolution, rotation deleting the old row), `lib/feedAccess.js`
(the single re-resolution point), `pages/api/feed/[token].js`,
`pages/api/feed/[token]/[file].js` (re-checks scope AND schedule before minting any
URL), and `deleteFeedToken` on viewer removal in `pages/api/admin/viewers.js`.

**Verify with:** `npm test -- feedTokens feedRoutes` — the suite drives the real
handlers, changes the world in Redis between two calls with the SAME token, and
asserts the second answer differs.

### (y) An admin-uploaded file served to everyone is a PNG, checked by its bytes

**Statement (2026-09-23):** the admin-set app icon (`lib/appIcon.js`) is the one piece
of admin-uploaded content served from this origin to anyone, signed in or not
(`/api/app-icon/<size>`, excluded from `proxy.js`'s matcher with the other PWA
assets). It is accepted only as a PNG — by its signature and IHDR header, never by a
declared type — of EXACTLY the size it is filed under, under a byte cap, and served
with `Content-Type: image/png`, `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'`. The browser resizes; the server trusts
none of it.

**Why:** "it is only an icon" is how an SVG with a script in it ends up executing on
the site's own origin. Do not widen the accepted types to SVG, and do not let the
declared type decide. The version is written LAST and cleared FIRST in `k("app_icon")`,
so a reader never pairs a version with a half-written set; it carries a letter prefix
because Upstash JSON-parses all-digit strings into numbers.

**Verify with:** `npm test -- appIcon appIconRoutes routes feedArtwork`.

### (s) Invariant (d) amended: the podcast feed may redirect to a signed, short-lived CDN media URL — nothing else may

**Statement:** Invariant (d) and change-control rule 3 say no direct bunny CDN file
URLs anywhere. A podcast feed cannot honour that literally — podcast apps fetch a media
URL, they do not render an iframe — so (d) is **narrowed**, not abandoned, and the
narrowing is written down here rather than discovered later in a diff:

1. No CDN URL ever appears in the feed document, in Redis, in a log, or in any client
   bundle. The `<enclosure>` points at **this app**
   (`/api/feed/<token>/<videoId>.mp4`). `lib/__tests__/feedRoutes.test.js` asserts the
   feed body contains no `b-cdn.net`.
2. The CDN URL exists only as a transient `302 Location`, minted per request **after**
   identity, group scope and the publish window have been re-checked.
3. It is pull-zone token-signed and expires in 15 minutes.
4. **Episode artwork (2026-09-23)** follows the same three rules through the same route:
   `<itunes:image>` points at `/api/feed/<token>/<videoId>.jpg`, which re-checks identity,
   scope and schedule, then asks bunny.net for the video's `thumbnailFileName`,
   validates it as a plain file name, and 302s to a 15-minute signed URL. Apps cache
   artwork for a long time keyed on the URL they were given — which is why that URL must
   be this stable one, never a signed CDN URL that would expire inside their cache.
   Verify: `npm test -- feedArtwork`.

What invariant (d) exists to prevent is "a permanent, unauthenticated, shareable
bypass". A 15-minute signed URL handed out only after a full authorization check is
none of those three. Everything else in the app — the watch page, the share page, the
public page — still plays only through `signEmbedUrl`, unchanged.

**`lib/bunny.js` was not modified.** The signing helpers there are byte-exact vendor
contracts; the new pull-zone signer lives in `lib/bunnyMedia.js` and **duplicates**
the thumbnail token formula rather than factoring it out, because refactoring a working
signature for a new caller's benefit is exactly the change most likely to silently
break thumbnails. Two copies, both pinned by tests, is the cheaper risk.

**bunny.net capability, verified not assumed (2026-09-13, against bunny.net's docs):**
Stream has **no audio-only or MP3 rendition**. Per-video storage is `playlist.m3u8`,
optional `play_{height}p.mp4` fallbacks, `original`, thumbnails/previews, and
`captions/*.vtt`. So episodes are video MP4s — playable in podcast apps, but a much
larger download than audio. Two conditions live on the bunny.net library and cannot be
set from this repo: MP4 Fallback must be enabled in its Encoding settings, and
bunny.net generates an MP4 only for videos uploaded **after** that was turned on. The
admin Settings panel states both next to the toggle.

**Enforced at:** `lib/bunnyMedia.js` (the only place a CDN media URL is built, with the
reasoning in its header), `pages/api/feed/[token]/[file].js` (the only caller),
`lib/podcast.js` (enclosures are app URLs by construction).

**Verify with:** `grep -rn "signedMp4Url\|signCdnPath" pages lib` — expect the
definitions plus exactly one caller. `npm test -- feedRoutes podcast`.

---

### (t) An admin-writable permission store may never widen what its holder already has

**Statement:** Roles are admin-defined (`lib/capabilities.js`, `lib/roles.js`) rather
than a fixed viewer/manager/admin ladder. That moves the permission table out of code
and into Redis, which an admin can write — so four properties keep it from becoming a
privilege-escalation surface, and all four have tests:

1. **The catalog is closed.** The 13 capability strings are defined in code. Unknown
   strings are dropped by `normalizeCapabilities` on write AND on read, so a
   hand-edited record claiming something that names no enforcement point grants
   nothing while reading as though it did.
2. **Owners resolve without Redis.** `ADMIN_EMAILS` holds the whole catalog,
   short-circuited before any read. Stored data can only ADD privilege to other
   people, never subtract it from an owner — demoting one is structurally impossible
   rather than guarded, which is strictly stronger than the old "an admin can't change
   an ADMIN_EMAILS address's role" check it replaced.
3. **No self-escalation.** `undelegatableCapabilities` gates every mutating branch of
   `pages/api/admin/roles.js`: an actor may only create, edit, delete or assign a role
   whose capabilities are a subset of their own. BOTH directions are checked — the new
   set (granting upward) and the current one (editing or deleting a role stronger than
   you), and on assignment the union of what is added and what is removed, because
   "demote the person above me" is escalation too.
4. **Resolution fails closed.** A non-owner whose capabilities can't be read resolves
   to none, matching invariant (c).

**Why:** the fixed-role model needed none of this, because the table was in code and
the only writable thing was which of three names someone had. Making roles
admin-defined is what created the surface; property 3 in particular is the whole
reason `roles.manage` can be delegated at all rather than being equivalent to handing
over every capability.

**Migration hazard, permanently documented:** `k("roles")` means something different
before and after this change (`email -> "admin"` vs `roleId -> record`). The shapes
coexist safely — `parseRole` rejects a bare string and `isValidRoleId` rejects any
field containing `@` or `.` — but "safely" means "does not corrupt", NOT "keeps
working". `lib/roleMigration.js` carries them over, in two halves: a read-time
fallback so nobody is locked out before the migration runs, and an idempotent
conversion that writes roles and assignments BEFORE deleting legacy rows, so a crash
leaves someone holding both rather than neither.

**Enforced at:** `lib/capabilities.js` (all four properties, pure),
`lib/roles.js` (storage + `resolveAccess`), `pages/api/admin/roles.js` (the ceiling on
every branch), `lib/roleMigration.js` (the upgrade path).

**Verify with:** `npm test -- roles roleMigration routes`;
`grep -c undelegatableCapabilities pages/api/admin/roles.js` (expect 6 — the import
plus a call on POST, PUT twice, PATCH and DELETE; a mutating branch without one is the
bug this invariant exists to catch).

### (x) When a response stops being self-limiting, its filter becomes load-bearing

**Statement:** `/api/transcript-search` returned IDS ONLY, and said so as a defence:
the client could only ever use an id to widen a list it already held, so an id it did
not hold matched nothing — the route's own filtering was belt, and the response shape
was braces. `/api/search`, which replaces it, returns full video objects, because the
whole point is to reach videos past the homepage cap that the client does NOT hold.
The braces are gone. The filtering is now the only thing between a search and a video
the viewer may not see.

**Why that is acceptable:** it is the same posture `/api/videos` has always had, and
the same pipeline — `fetchVideoLibrary(scope)` applies group scope, publish window and
ready-only. `/api/search` differs from it in exactly one way, `{ cap: false }`, and the
homepage count is a DISPLAY limit rather than access control, so nothing the search
returns was ever out of the viewer's reach.

**What this costs, and the rule it implies:** a bug in the scope filter used to be
survivable here and now is not. So the route's tests assert the filtering directly —
that the viewer's own scope is passed down, and that the cap is the only thing
disabled — rather than inferring safety from the response shape.

**The general rule:** when you widen a response from identifiers to objects, you are
removing a safety property, not just changing a payload. Say so, and move the proof
from the shape to the filter.

**Enforced at:** `pages/api/search.js` (guard, rate limit, `fetchVideoLibrary(access.videoScope, { cap: false })`),
`lib/videoList.js` (the `cap` option and the comment explaining it is a display limit),
`lib/search.js` (pure; searches an already-authorized list and does no access checking
at all, which its own comment states).

**Verify with:** `npm test -- searchRoute` — the suite fails if the scope stops being
passed down or the cap comes back.


**Passage search rides the same predicate (2026-09-23).** `videoMatchesQuery`
(`lib/notes.js`) also matches a query that IS a scripture reference against the
references `lib/scripture.js` reads from a video's title and notes. Both halves call
that one predicate — the browser over its loaded page, `/api/search` via
`searchLibrary` over the scoped library — so they cannot disagree, and neither
reaches a video the other could not. It only adds matches. `lib/scripture.js` is
PURE and bundled into the homepage, so it must not use regex lookbehind: that is a
SyntaxError at parse time in Safari before 16.4 and would take the whole library
page down, not just this feature. Verify: `npm test -- scripture notes search`;
`grep -n "(?<" lib/scripture.js` prints nothing.

**Browse by book (2026-09-23).** `/api/passages` counts, per book, the videos citing it —
over `fetchVideoLibrary(access.videoScope, { cap: false })`, exactly the pipeline
`/api/search` uses. The count is information in its own right ("Philippians (3)" says
three videos exist), so an index built over anything wider than the viewer's scoped
library would leak what the scope hides. `bookIndex` reads the same title+notes the
passage search matches, so every listed book finds at least one video. Verify:
`npm test -- passagesRoute scripture`.

**Word stems (2026-09-23).** `videoMatchesQuery` also matches a query's words by stem
(`lib/stem.js`) against a video's title and notes — through the same one predicate, so
both halves of search still agree. Additive only. A query that parses as a passage is
answered by passage overlap ALONE; letting stems in would read "Philippians 2" as the
word "philippians" and widen it to the book. `lib/stem.js` is client-bundled: no regex
lookbehind. Verify: `npm test -- stem notes`.
---

### (w) A route that reveals or edits PEOPLE requires the people capability, whatever else it manages

**Statement:** `/api/admin/groups` is gated on `groups.manage`, but its membership
surface — the member addresses in `GET`, and the whole of `PATCH` — additionally
requires `viewers.read`. A groups-only manager sees the group record and a member
COUNT, exactly as before membership editing existed.

**Why:** membership is a tag on a viewer, so editing it is editing viewer records, and
listing it is handing out addresses. Less obviously, the per-address *result* of a
change ("not an approved viewer") answers the same question the viewer list does, so
returning it to a caller who may not read that list would make the endpoint an
enumeration oracle. Both halves go behind the same capability.

**Why the WRITE needs nothing more than `groups.manage`:** a `groups.manage` holder can
already change what every member of a group can watch — widen the allowlist, clear
`restricted`, or delete the record entirely. Moving a viewer between groups grants no
power they did not have. What it adds is visibility of *people*, which is exactly what
the `viewers.read` requirement covers. This is the same reasoning as
`assignmentNeedsViewerManage` in `lib/capabilities.js`: ask what the action actually
widens, and gate that, rather than gating on which noun the route is named after.

**Enforced at:** `pages/api/admin/groups.js` (the `hasCapability(access, CAP.VIEWERS_READ)`
check on `PATCH` and on the `members` field of `GET`), `lib/groups.js`
(`planMembershipChange` is pure and decides nothing about who may call it).

**Verify with:** `npm test -- groupRoute groupMembership` — the route suite fails if a
groups-only manager can reach the membership branch at all.

---

### (v) Per-viewer data is keyed by the viewer; aggregates hold no identity and equal the data

**Statement:** anything recorded about a person — progress, saved list, ratings — is
stored under a key that carries their email (`fablevideo:progress:<email>`,
`mylist:<email>`, `ratings:<email>`), never as a field under the thing it is about.
Aggregates derived from that data (`fablevideo:rating_counts`) hold plain integers and
no identity at all.

**Why:** the obvious shape for ratings is a hash per video, field = email. It reads
better and makes the admin's totals a single `HGETALL`. It also leaves a removed
viewer's address sitting in a row that nothing cleans — there is no sweep over video
keys, and adding one would mean scanning every video on every viewer removal. Keying
by viewer means deleting a person's data is one key per feature, for every per-viewer
feature at once, including ones not written yet. **That deletion does not run today**:
`removeViewer` clears only the viewer record and last-seen time (FEATURES.md, known
gaps). Do not describe removal as deleting their data until it does.

**Totals equal the votes (2026-09-23).** A vote and both counter moves are ONE Redis
script (`VOTE_SCRIPT`, `lib/ratingScripts.js`), and the previous vote is read INSIDE it.
Before that they were two writes — vote, then a best-effort `HINCRBY` — and a failure
between them, or two racing clicks both reading "no vote", left a total wrong for good.
Totals from that era are corrected by `RECOUNT_SCRIPT`, run from **Recount ratings**
(`/api/admin/rating-recount`, `SETTINGS_MANAGE`), which rebuilds and replaces the
counter hash from every `ratings:<email>` hash in one atomic step. Its one scan is the
same maintenance exception the stale-bundle cleanup makes. Do NOT reintroduce a
separate counter write "for simplicity": that is the drift this removed.

**Enforced at:** `lib/ratingScripts.js` (both scripts; no imports, so the tests run the
exact strings), `lib/ratings.js` (pure; `voteDelta` is the specification the vote script
is held to, transition by transition), `lib/store.js` (`recordRating` = one `EVAL`;
`recountRatings`; `clearVideoRatingCounts` on delete), `pages/api/rating.js` (no email
parameter; scope-gated; one storage call per vote).

**Verify with:** `npm test -- ratings ratingRoute ratingScripts ratingsStore.redis ratingRecountRoute`
(`ratingScripts` and `ratingsStore.redis` run on a real `redis-server`, SKIPPED locally where none is installed and FAILING under CI —
check the summary says 36 passed, not skipped); `grep -n "ratings\|rating_counts" lib/store.js`
(the vote keys take an email, the counter key does not).

---

### (u) A generated suggestion is never a stored value — the AI proposes, a person accepts

**Statement:** bunny's Transcribe AI can generate titles, descriptions, chapters and
moments. Three of those are off at the call site and one — `generateChapters` — is
opt-in (`lib/bunny.js`, `transcribeVideo`). Whatever it generates lands on **bunny's**
video object and is read back READ-ONLY: `lib/aiChapters.js` is pure (no store import
at all), and the `suggestions` branch of `pages/api/admin/transcribe.js` writes
nothing — not `fablevideo:chapters`, not the transcript, not even the audit log,
because nothing changed. A suggestion becomes a chapter only when an admin loads it
into the chapters textarea and saves, which goes through `set-chapters` and
`parseChapters` exactly as a hand-typed list does.

**Why:** two writers for one field is how hand-written work gets silently replaced.
The admin who typed "24:15 Sermon" would have no way to tell that a transcription job
run for the captions had overwritten it, and no way to get it back. Keeping the
acceptance in the admin's hands costs one click and removes the whole class of
failure. The same reasoning is why titles and descriptions stay off entirely: nothing
here reads a generated title, so generating one is a write with no reader.

**The corollary for anything new:** if a future integration generates content that
overlaps something a person authors here, the generated copy goes somewhere the
person's copy is not, and a person moves it across. Do not add a second writer.

**Field-name caveat, deliberately recorded:** `title`/`start` come from bunny's docs,
not from a live job — this path has never run against a real transcription. The reader
accepts a few spellings and REPORTS what it could not read, so a docs/reality mismatch
shows up as "3 suggestions could not be read" rather than as silence.

**Enforced at:** `lib/aiChapters.js` (pure reader), `lib/bunny.js` (the generate flags),
`pages/api/admin/transcribe.js` (the read-only `suggestions` branch),
`pages/admin.js` (`DetailsEditor` — loads into the textarea, confirms before replacing
text already typed, saves nothing by itself).

**Verify with:** `npm test -- aiChapters transcribeRoute` (the route test asserts the
suggestions branch calls neither `setTranscript` nor `logAction`, and never reaches the
paid call even with the rate limit exhausted); `grep -n "Store\|redis" lib/aiChapters.js`
(expect no output).

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
19. **Am I adding per-video content (chapters, notes, anything similar)?** Its absence
    must mean "behaves exactly as before", the parsing must live in a Redis-free module
    if anything client-reachable imports it, and every read of it must be wrapped so a
    failure costs the decoration and nothing else. (o)
20. **Am I sending a notification that is not for everyone?** Use `sendPushToEmails`,
    never `sendPushToApproved`; derive the recipients from a capability rather than a
    role name; wrap the whole thing so a delivery failure can't fail the action it
    describes. (p)
21. **Am I adding a path that serves content without a session?** There is exactly one
    today (q). A second needs an explicit decision, must be default-deny, must fail
    CLOSED, and must be its own file rather than a branch in an existing gate.
22. **Am I authenticating something with a bearer token instead of a session?** The
    token may identify an account and nothing more; re-resolve entitlement on every
    request from the same functions the website uses, and make every denial identical
    (r).
23. **Am I about to build a direct bunny CDN file URL?** Invariant (d) forbids it
    everywhere except the one narrowed case in (s). If you think you need another,
    that is a design decision for the owner, not a local call.
24. **Is this change touching one of the weak points in section 3?** If so, treat it as
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

**Updated 2026-09-03 (dynamic PWA manifest):** invariant (k) updated — the manifest is
now generated per-request by `pages/api/manifest.js` (rewritten from `/manifest.webmanifest`
in `next.config.js`) instead of being a static file, so its content can vary; the invariant's
safety property (public, non-secret, same for every caller) is unaffected and the section
title/wording was adjusted to stop implying the cached content itself must be immutable.
Line-number citations refreshed against `public/sw.js` on that date. Verified by reading
`pages/api/manifest.js`, `next.config.js`, `pages/_document.js`, and `public/sw.js` directly.

**Updated 2026-08-31 (access requests, verified email, schedules, route tests):**
invariant (m) extended to cover `lib/schedule.js` and to record why schedule reads fail
OPEN while group scope fails CLOSED; invariant (n) added for the one unapproved-reachable
endpoint and for `REQUIRE_VERIFIED_EMAIL`. Route-level coverage now exists for the
authorization layer (`lib/__tests__/routes.test.js`), so the "no route tests at all"
weak point in section 3 is narrower than it was — pages and business logic are still
uncovered.

**Updated 2026-09-15 (custom roles):** the fixed viewer/manager/admin model is gone,
replaced by admin-defined roles over a 13-capability catalog, ported from the sibling
`fable-video2` repo. Added invariant (t). Invariant (b)'s capability names all changed
(`CAP.VIDEOS` → `CAP.VIDEOS_READ`/`_MANAGE`, `CAP.PEOPLE` → `CAP.VIEWERS_*`,
`CAP.INSIGHTS` → `CAP.ANALYTICS_READ`/`CAP.AUDIT_READ`), and routes that both list and
mutate now split by method. `isStaffRole(role)` is replaced by `access.staff`, which is
"holds at least one capability". Section 3's "admins are env-var-only" weak point stays
resolved, and its guardrails are now stronger: owner demotion is impossible rather than
blocked. Verified by reading every file named above and running the suite (25 files /
384 tests).

**Updated 2026-09-13 (public links + podcast feed):** added invariants (q) (the single
anonymous video route, default-deny and fail-CLOSED — the deliberate inversion of the
schedule's polarity), (r) (a feed token is an identity claim, never an entitlement) and
(s) (**invariant (d) is narrowed**: the podcast media route may 302 to a signed,
15-minute CDN URL after a full authorization re-check; nothing else may, and
`lib/bunny.js` was not touched). Checklist items 21-23 added. The bunny.net
audio-only question was resolved against bunny.net's documentation, not assumed:
there is no audio-only rendition, so episodes are MP4 video. Verified by reading
`lib/publicVideos.js`, `lib/bunnyMedia.js`, `lib/feedTokens.js`, `lib/feedAccess.js`,
`lib/podcast.js`, `pages/watch/public/[id].js`, both feed routes and
`pages/api/admin/public-videos.js`, and by running the suite (23 files / 323 tests).

**Updated 2026-09-13 (chapters, sermon notes, access-request notifications):** added
invariants (o) (additive per-video decoration; the search narrows and never widens; the
pure/storage split as a house pattern) and (p) (addressed vs broadcast push; capability-
derived recipients; best-effort and inert-until-configured). Verified by reading
`lib/chapters.js`, `lib/notes.js`, `lib/videoMeta.js`, `lib/accessRequestNotify.js`,
`lib/push.js`, `lib/roles.js`, `lib/videoList.js`, `pages/watch/video/[id].js` and
`pages/api/admin/videos.js` on that date, and by running the suite (18 files / 240
tests). Also in that change: `pages/api/admin/notify.js` moved its capability guard
ABOVE its `req.method` check — it was the only admin route answering an unauthorised
caller with a 405.

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
| The capability catalog (13, closed, defined in code) | `sed -n '1,70p' lib/capabilities.js` |
| No-self-escalation ceiling still enforced on every mutating roles branch | `grep -c undelegatableCapabilities pages/api/admin/roles.js` (expect 6: the import plus five call sites — POST, PUT ×2, PATCH, DELETE) |
| Legacy fixed-role rows still resolve until migrated | `npm test -- roleMigration` |
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
| Only ONE caller of `isPublicVideo` (q) | `grep -rn "isPublicVideo" pages lib` (definition + the public page, nothing else) |
| The public flag fails closed on a Redis error (q) | `npm test -- publicVideos` |
| Publishing needs CAP.SETTINGS_MANAGE, not the videos.* caps (q) | `grep -n "requireCapability" pages/api/admin/public-videos.js`; `npm test -- publicRoute` |
| Feed entitlement is re-resolved per fetch, not cached (r) | `npm test -- feedRoutes` — the same token, two different answers |
| The feed body never contains a CDN url (s) | `npm test -- feedRoutes` (asserts no `b-cdn.net` in the document) |
| Only the feed media route builds a CDN media url (s) | `grep -rn "signedMp4Url\|signCdnPath" pages lib` (definitions + one caller) |
| `lib/bunny.js` signing helpers still untouched (s) | `git log --oneline -- lib/bunny.js` |
| Search passes the viewer's scope and disables only the display cap (x) | `npm test -- searchRoute search` |
| Group membership needs viewers.read, not just groups.manage (w) | `npm test -- groupRoute groupMembership` |
| Per-viewer data is keyed by the viewer; aggregates hold no identity and equal the data (v) | `npm test -- ratings ratingRoute ratingScripts ratingsStore.redis ratingRecountRoute` (ratingScripts, ratingsStore.redis need `redis-server`); `grep -n "ratings\|rating_counts" lib/store.js` |
| AI suggestions write nothing, anywhere (u) | `npm test -- aiChapters transcribeRoute`; `grep -n "Store\|redis" lib/aiChapters.js` (expect no output) |
| Chapters/notes modules import no Redis (o) | `grep -n "^import" lib/chapters.js lib/notes.js` (expect no output) |
| Chapters/notes are read only AFTER every access check (o) | `grep -n "scopeAllows\|getSchedule\|getChapters" "pages/watch/video/[id].js"` (the first two must precede the third) |
| Access-request notification is addressed, not broadcast (p) | `grep -n "sendPushTo" lib/accessRequestNotify.js` (expect only `sendPushToEmails`) |
| Every admin route guards before its method check | `npm test -- routes` — the `/api/admin/notify` ordering tests |
| Push sends filter live viewers; announce is atomic; click is same-origin (l) | `sed -n '100,143p' lib/push.js`; `grep -n 'startsWith("/")' pages/api/admin/notify.js` |
| Lint/test/build baselines | see `change-control`'s Provenance table — same repo, same date |
