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

**Enforced at:** `lib/auth.js:4-8` (`normalizeEmail`), used by `lib/auth.js:17-20`
(`isAdmin`), `lib/guard.js:7-11` (`sessionEmail`), and directly in
`pages/index.js:21`, `pages/admin.js:25`, `pages/watch/[shareId].js:14`,
`pages/watch/video/[id].js`, `pages/api/admin/viewers.js`, `pages/api/admin/share.js:27`.

**Verify with:** `grep -rln "normalizeEmail" lib pages` (expect `lib/auth.js`,
`lib/guard.js`, `pages/admin.js`, `pages/index.js`, `pages/watch/[shareId].js`,
`pages/watch/video/[id].js`, `pages/api/admin/share.js`, `pages/api/admin/viewers.js`) —
and `grep -rn "user.email ===" pages lib` should return **nothing** (raw comparison).

### (b) Every `/api/admin/*` route independently calls `requireAdmin` — the SSR gate on `/admin` is not sufficient alone

**Statement:** `pages/admin.js`'s `getServerSideProps` redirects non-admins before any
admin HTML ships, but that only protects the *page*. Every one of the 11 route files
under `pages/api/admin/` starts its handler with `const admin = await requireAdmin(req,
res); if (!admin) return;` — an independent, second check.

**Why:** API routes are reachable directly (curl, browser devtools, a stale bookmark, a
future UI bug that calls an admin endpoint from a non-admin page) regardless of what the
`/admin` page itself renders. A single gate at the page level would mean any route bug or
direct API call bypasses authorization entirely.

**Enforced at:** `lib/guard.js:41-49` (`requireAdmin`); called at the top of all 11 files
in `pages/api/admin/*.js` (`analytics.js:31`, `audit.js:10`, `collections.js:8`,
`order.js:7`, `settings.js:9`, `share-email.js:14`, `share.js:17`, `shares.js:8`,
`upload.js:11`, `videos.js:17`, `viewers.js:9`).

**Verify with:** `grep -L requireAdmin pages/api/admin/*.js` (expect **no output** — every
file matches).

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

**Enforced at:** `lib/guard.js:22-39`, `lib/ratelimit.js:23-30`.

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

---

## 2. Load-bearing decisions (don't undo these without a deliberate call)

| Decision | Why it's load-bearing |
|---|---|
| **Pages Router, not App Router.** No `app/` directory exists anywhere in the repo (confirmed: `ls` at repo root shows no `app/`). | The entire codebase — `getServerSideProps` auth gates on `pages/index.js`, `pages/admin.js`, `pages/watch/[shareId].js`, the `pages/api/**` route-handler shape, `proxy.js`'s role as the Next 16 network boundary — assumes Pages Router conventions. Adding an `app/` directory would create two competing routing systems and likely double-mount or bypass the auth gates. Don't add one without a full migration plan (out of scope for a routine change). |
| **`proxy.js`'s broad matcher is required for rolling session refresh.** `config.matcher` excludes only `_next/static`, `_next/image`, `favicon.ico`, `sitemap.xml`, `robots.txt` (`proxy.js:11-15`) — everything else, including every page and every API route, passes through `auth0.middleware(request)`. | The inline comment states it directly: "the broad matcher is required for rolling sessions to refresh on ordinary page/API traffic" (`proxy.js:12-13`). Narrowing the matcher (e.g., to only `/admin` or only `/api/*`) would stop session cookies from refreshing on requests that don't hit it, causing sessions to expire mid-use on excluded routes. |
| **Shares are TTL-native Redis records plus an index set with opportunistic pruning.** `createShare` sets the record with `{ ex: ttlHours * 3600 }` (`lib/shares.js:38`) and adds the id to a separate index set (`lib/shares.js:39`, `sadd`). `updateShare` (`lib/shares.js:50-59`) reads the record's *remaining* TTL via `r.ttl(key)` and re-sets with that same remaining value (`ex: ttl`), never resetting the clock. `listShares` (`lib/shares.js:69-85`) reads the index, `mget`s all records, and opportunistically `srem`s any id whose record already expired (lines 79-83). | If `updateShare` re-set a fresh TTL instead of preserving the remaining one, every view-stamp or email-stamp update (which happens on ordinary use — first play, resend email) would silently extend a share's life past what the admin configured, defeating the whole point of a time-limited link. The index-set-plus-pruning design exists because Redis has no "list all keys matching a TTL'd pattern" primitive at scale; the index is the only way to enumerate shares for the admin's Shares tab, and dead entries are cleaned lazily rather than via a cron job (there is none in this repo). |
| **The video list is cached for 4 seconds per warm serverless instance, and the homepage does an SSR-first-page fetch with client-side filtering after that.** `listAllVideos()` promise-caches for `VIDEO_LIST_CACHE_TTL_MS = 4000` (`lib/bunny.js:47,77-88`); `pages/index.js`'s `getServerSideProps` calls `fetchVideoLibrary()` server-side (lines 40-53) so the first paint already has data, and all search/collection-filter/pagination interaction after that happens client-side against the one fetched list (`pages/index.js:186-198`, no network round trip per keystroke — see file header comment lines 1-6). | This is what commit `68ee934` (homepage speedup) and `b9e2b22` (client-side search/filter/pagination) bought: no round trip per keystroke, and the homepage doesn't wait for hydration-then-fetch. The cost is invariant (f) above — every mutation must remember to invalidate — and known weak point below (per-instance cache disagreement). |
| **Settings, viewers, and video order live in Redis, not code or env vars, so admins never redeploy for day-to-day changes.** `lib/store.js` — `getSettings`/`saveSettings`, `getOrder`/`saveOrder`, `listViewers`/`addViewers`/`removeViewer`, `getTheme`/`saveTheme` all read/write Redis directly, with no caching layer and no env var involved. | This is explicitly why the admin panel (`pages/admin.js`) can change the homepage video count, reorder videos, add/remove approved viewers, and change the color palette live, with effects visible on the next request — no Vercel redeploy, unlike `ADMIN_EMAILS` (see weak point below) or any `RESEND_API_KEY`/`BUNNY_*` env var change. |

---

## 3. Known weak points (stated plainly, not sugar-coated)

| Weak point | Detail | What to do about it |
|---|---|---|
| **Orphaned `pvp:*` Redis keys.** | Commit `c37919e` (2026-07-09) renamed the key prefix from `pvp:` to `fablevideo:` in `lib/redis.js` with **no migration** — the commit message states this explicitly ("All data is stored fresh so there's no migration"). Any data written before that commit under the old prefix is invisible to the app today and will never be read or cleaned up by it. | If you ever need to account for "missing" historical data (viewers, shares, settings) from before 2026-07-09, check for a stray `pvp:*` keyspace in Redis directly — the app will never surface or clean it. Not an active problem, just a fact to know before debugging "where did old data go." |
| **Email claim is trusted; no `email_verified` enforcement in app code.** | `lib/auth.js` and `lib/guard.js` trust `session.user.email` as-is (after normalization) with no check of an `email_verified` claim from Auth0. `grep -rn email_verified` across `lib/` and `pages/` returns no hits outside `node_modules`. | Mitigated operationally, not in code: README "Security notes" (line ~204) and the one-time setup checklist (line 150) both instruct disabling Auth0 self-sign-up ("Disable Sign Ups") and adding people manually, so nobody can register an unverified address themselves. If that operational control is ever relaxed, this becomes a real gap — route to `security-response` if you're asked to harden it. |
| **Per-serverless-instance cache means instances can disagree for up to 4 seconds.** | `videoListCache` in `lib/bunny.js:48` is a module-level `let`, meaning each warm Vercel serverless instance has its own independent cache and its own independent 4-second clock. Two viewers hitting two different warm instances immediately after an admin mutation can see different library states for up to 4s, even though invariant (f) is fully respected. | This is accepted behavior for a 4-second window, not a bug to fix reflexively. If a future feature needs strict read-after-write consistency (e.g., a "confirm your video is live" admin flow), don't assume the cache is consistent — poll or bypass `listAllVideos()`. |
| **Admins are env-var-only (`ADMIN_EMAILS`), unlike viewers/settings/order.** | Unlike approved viewers (Redis, live via `/admin`), the admin list is `process.env.ADMIN_EMAILS` (`lib/auth.js:10-15`), parsed fresh on every call but only changeable by editing the Vercel env var and **redeploying** (README: "changes only apply to new deployments"). There is no UI to promote/demote an admin. | Expect "add me as an admin" requests to require an env var change + redeploy, not an admin-panel action — this is a real operational asymmetry from the viewer-management flow, not an oversight to silently "fix" by adding a Redis-backed admin list without discussion (that would be a security-relevant design change — route through `security-response` if proposed). |
| **No lockfile means dependency drift can break a deploy or CI with zero code change.** | `.gitignore` blocks `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml` by design (doctrine: keep dependencies on latest versions within `package.json`'s caret ranges). A new patch/minor release of any dependency can change behavior or break the build between two otherwise-identical commits. | Not this skill's territory — route to `dependency-currency` for the latest-versions doctrine and the ESLint 9.x pinning exception (commit `f2d3a30`). |
| **API routes and pages have no automated test coverage.** | Vitest covers only `lib/__tests__/` (`auth.test.js`, `email.test.js`, `order.test.js`, `theme.test.js` — 4 files, 24 tests, pure logic). Nothing under `pages/api/**` or `pages/*.js` is exercised by an automated test; `npm run lint` and `npm run build` are the only automated checks on that code. | Don't assume a passing `npm test` says anything about route-level behavior (guard ordering, status codes, request/response shape). Route to `validation-and-qa` for what to add and how. |

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
12. **Am I about to add an `app/` directory, narrow `proxy.js`'s matcher, reset TTL on
    share updates, or move viewer/settings/order data out of Redis?** Any of these needs a
    deliberate, explicit decision — not an incidental side effect of an unrelated change.
    (Section 2)
13. **Is this change touching one of the weak points in section 3?** If so, treat it as
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

| Volatile claim | Re-verify with |
|---|---|
| All 11 `/api/admin/*` routes call `requireAdmin` | `grep -L requireAdmin pages/api/admin/*.js` (expect no output) |
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
| Share TTL preserved on update | `sed -n '50,59p' lib/shares.js` |
| Video-list cache TTL and per-instance scope | `grep -n "VIDEO_LIST_CACHE_TTL_MS\|let videoListCache" lib/bunny.js` |
| `pvp:*` keys were never migrated | `git show c37919e --stat` and read the commit message |
| Admins are env-var-only, no Redis admin list | `grep -n "ADMIN_EMAILS" lib/auth.js`; confirm no `k("admin` anywhere: `grep -rn 'k("admin' lib` |
| Test coverage still limited to `lib/__tests__/` | `ls lib/__tests__/`; `grep -rL "test(" pages/api/**/*.js 2>/dev/null \| wc -l` (all of them, since none have tests) |
| Lint/test/build baselines | see `change-control`'s Provenance table — same repo, same date |
