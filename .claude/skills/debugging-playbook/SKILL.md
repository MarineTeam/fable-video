---
name: debugging-playbook
description: Symptom-to-fix runbook for runtime failures in the Marine Video Portal — 502s ("Could not load viewers", "Could not load videos from bunny.net", etc.), admin tabs failing to load, viewers/settings/shares data that "vanished", login loops or Auth0 "callback URL mismatch", a user who is approved but sees "Your account is not approved to view videos", homepage showing a title list instead of thumbnails, thumbnails returning 403 when opened directly, upload failing with HTTP 401, share emails not sending, a share link showing "expired or doesn't exist", resume/continue-watching not working, a video stuck on "Processing", "Too many..." 429 responses, `npm install` failing on deploy, or a build that passes locally but fails in CI. Load this when something is broken at runtime and you need to go from a user-visible symptom to a root cause and fix, not when you're about to change code (see change-control) or investigate a past incident in depth (see failure-archaeology).
---

# Debugging playbook — Marine Video Portal

This skill turns a user-visible symptom into a root cause and a fix. It is built entirely
from this repo's actual code: every log line quoted below is a real `console.error` string
grepped out of `pages/api/**/*.js`, and every incident cited is a real commit. Re-verify
anything you rely on with the commands given — this file is dated 2026-07-13 against a
repo whose facts are known to drift (no lockfile, live Redis data, Vercel env config that
changes independently of code).

## When NOT to use this skill

| You are trying to... | Use instead |
|---|---|
| Know which gates/checklist apply before editing a file | `change-control` |
| Understand *why* the architecture is shaped this way (guard pattern, cache invariants) | `architecture-contract` |
| Respond to a CodeQL alert or a suspected vulnerability | `security-response` |
| Bump a dependency or fix an `npm install`/peer-dependency failure | `dependency-currency` |
| Dig into the full history of a past incident, not just "what do I do now" | `failure-archaeology` |
| Look up bunny.net/Auth0/Upstash/Resend API specifics | `domain-reference` |
| Add or change an environment variable, or edit a config file | `environment-and-config` |
| Deploy, redeploy, roll back, or otherwise operate the running app | `run-and-operate` |
| Write or extend automated tests | `validation-and-qa` |
| Run a diagnostic script (e.g. inspect Redis directly) instead of guessing | `diagnostics-and-tooling` |
| Write README/CHANGELOG prose | `docs-and-writing` |
| Plan and ship a whole new feature | `feature-shipping-campaign` |

If you're not sure whether something is "broken" (a design question, a missing feature) vs.
"failing" (an error, a wrong result), this skill is for the latter only.

---

## 1. Triage order (do this every time, in this order)

1. **Reproduce and capture the exact user-visible message.** Not a paraphrase — the literal
   toast/error text, HTTP status code, and which admin tab or page it happened on. Every row
   in the symptom table below is keyed off exact text; a paraphrase will send you down the
   wrong row.
2. **Find the server log line.**
   - **Production:** Vercel dashboard → the project → **Logs** (or **Functions** for a
     specific route) → filter by the route path or time window. Every `catch` block in
     `pages/api/**/*.js` runs `console.error("<label>:", err)` before returning its 4xx/5xx
     (this is a hard rule of the repo — see `change-control` non-negotiable #2 — so if a
     request 502'd, a matching log line exists unless logging itself is broken).
   - **Local dev:** the terminal running `npm run dev` — same `console.error` calls print
     directly there.
3. **Match the log line (or, if there's no log line, the HTTP status + UI text) against the
   symptom table in section 2.** Match on the quoted label text, not vibes — labels are
   deliberately specific per endpoint.
4. **If nothing matches:** don't guess and patch blindly. Use `diagnostics-and-tooling` to
   measure directly (e.g. inspect Redis contents, hit an endpoint with curl, check env vars
   actually present at runtime) before changing code. A wrong guess that "fixes" a symptom
   without addressing the logged cause is exactly the failure mode rule #2 (below, and in
   `change-control`) was created to prevent.

---

## 2. The symptom table

Every `console.error` label below was extracted with `grep -rn "console.error" pages/api
--include="*.js"` on 2026-07-13; re-run that command if this file is old. All are 502
responses unless noted. Endpoint paths mirror the file path (e.g.
`pages/api/admin/viewers.js` → `POST/GET/DELETE /api/admin/viewers`).

| User-visible symptom | Exact log signature | Endpoint(s) | Root cause | Fix runbook | Evidence |
|---|---|---|---|---|---|
| Every admin tab fails to load (Viewers, Shares, Settings, Videos, Activity, Analytics all 502) | `"Could not load viewers:"`, `"Could not load share links:"`, `"Could not load settings:"`, `"Could not load videos from bunny.net:"`, `"Could not load the activity log:"`, `"Could not load analytics:"`, `"Could not load the video order:"` — AND the underlying Upstash error text `"[Upstash Redis] Redis client was initialized without url or token. Failed to execute command."` | all of `pages/api/admin/*.js` | Vercel injected a **prefixed** Redis env var name (e.g. `fablevideo_KV_REST_API_URL`) instead of plain `KV_REST_API_URL`, because more than one storage database is connected to the project | `lib/redis.js`'s `envBySuffix()` already handles this (matches any var *ending in* `KV_REST_API_URL`/`KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_URL`/`_TOKEN`) — if you still see this, the fix already shipped but a **redeploy is needed** to pick it up, or the store genuinely isn't connected. Verify: Vercel → Settings → Environment Variables → confirm a var ending in `KV_REST_API_URL`/`KV_REST_API_TOKEN` exists for the right environment (Production/Preview), then trigger a redeploy | commit `84dfbe3`; `lib/redis.js:11-19`; README "Common issues" |
| Admin data (viewers / settings / order / theme / shares) that existed before looks empty or "reset" | No error at all — request succeeds, returns empty | `pages/api/admin/*` reading from `k("viewers")`, `k("settings")`, `k("order")`, `k("theme")` | Key prefix was renamed `pvp:` → `fablevideo:` in commit `c37919e` **without migrating old data**. Any Redis write from before 2026-07-09 is orphaned under `pvp:*` — the app now reads/writes `fablevideo:*` exclusively and never sees it | Not a code bug — the old data is still in Redis, just under the old prefix. Use `diagnostics-and-tooling` to inspect Redis keys directly (list keys matching `pvp:*` and `fablevideo:*`) to confirm. If the data must be recovered, that's a manual one-time migration (copy `pvp:X` → `fablevideo:X` per key), not something to automate into app code — route through `run-and-operate` | commit `c37919e`; `lib/redis.js:3-9` (`PREFIX = "fablevideo"`) |
| Login loop, or Auth0 shows "callback URL mismatch" | No app-side log — Auth0 rejects the redirect before the app runs | Auth0 login/callback | `@auth0/nextjs-auth0` v4 mounts routes at `/auth/*` (not `/api/auth/*`) via `proxy.js`. Either the Auth0 app's Allowed Callback URLs still points at the old `/api/auth/callback` path, or `APP_BASE_URL` doesn't exactly match the deployed URL (trailing slash, wrong scheme, wrong domain) | In the Auth0 dashboard, set Allowed Callback URLs to `https://<domain>/auth/callback` (not `/api/auth/callback`) and Allowed Logout URLs to `https://<domain>`. Confirm `APP_BASE_URL` in Vercel has no trailing slash and matches the exact production URL, then redeploy | README "One-time setup checklist" item 2 and "Common issues"; `proxy.js` |
| User insists they're approved but sees "Your account is not approved to view videos" | `403` from any `requireApproved`-gated route (`/api/videos`, `/api/progress`, `/api/collections`); no `console.error` — this is a deliberate fail-closed 403, not an infra error | `lib/guard.js:22-39` (`requireApproved`) | Email in `fablevideo:viewers` hash doesn't exactly match the session email after normalization — most likely the viewer record predates a normalization fix, was added with different casing/whitespace some other way than the app's own bulk-add UI, or (see the row above) is an orphaned `pvp:*` record that never migrated | Compare `normalizeEmail(session email)` (trim + lowercase, `lib/auth.js:4-8`) against the exact string stored under `fablevideo:viewers` for that user with `diagnostics-and-tooling`. If it's missing/mismatched, remove and re-add the viewer from `/admin` → Viewers (which always normalizes via `parseEmailList`) | `lib/guard.js:22-39`; `lib/auth.js:4-8,26-41`; `lib/store.js:80-82` (`isApprovedViewer` uses `hexists`, exact match) |
| Homepage shows a plain title list instead of a thumbnail grid | No error — `thumbnailsEnabled()` returns false, so `/api/videos` and `/api/admin/videos` return `thumbnails: false` / null thumbnail URLs | `pages/api/videos.js`, `pages/api/admin/videos.js` | `BUNNY_CDN_HOSTNAME` is unset, or the deploy that set it hasn't been redeployed yet | Set `BUNNY_CDN_HOSTNAME` (the library's CDN/pull-zone host) in Vercel, redeploy. Verify: `lib/bunny.js:173-175` (`thumbnailsEnabled()` is `Boolean(cdnHostname())`) | README "Common issues"; `lib/bunny.js:16,173-175` |
| Thumbnail URL opened directly in a new tab/browser returns 403 | N/A — client-side, no server log | CDN (bunny.net pull zone) | **Expected, not a bug.** "Block Direct URL File Access" hotlink protection on the bunny.net library checks Referer; the app's own `<img>` requests carry the site's Referer and work fine, a bare URL pasted into a browser doesn't | Nothing to fix. Confirm it loads normally inside the app's grid | README "Common issues" ("Thumbnails 403 directly but load in the app — expected"); `lib/bunny.js:177-195` |
| Upload fails with HTTP 401 (during the direct browser→bunny.net TUS transfer, after `/api/admin/upload` succeeded) | Not in this app's logs — the 401 comes back from bunny.net's TUS endpoint itself, visible in the browser network tab, not Vercel logs | TUS upload to `https://video.bunnycdn.com/tusupload` (signed by `signTusUpload` in `lib/bunny.js:158-171`) | A stray newline/space pasted into `BUNNY_API_KEY` or `BUNNY_LIBRARY_ID` in Vercel corrupts the TUS `signature = SHA256(libraryId + apiKey + expire + videoId)` even though `lib/bunny.js:11` trims env values when *read* — a literal newline inside the middle of a multi-line paste survives trimming | Re-paste `BUNNY_API_KEY` and `BUNNY_LIBRARY_ID` cleanly (single line, no surrounding whitespace) in Vercel → Settings → Environment Variables, redeploy | README "Common issues"; `lib/bunny.js:9-15,156-171` |
| Share email isn't sending (admin creates/resends a share, no email arrives) | Admin UI surfaces the exact Resend error inline — e.g. `"Email delivery failed: <resend message>"` or, if unconfigured, `"Email delivery is not configured (set RESEND_API_KEY and EMAIL_FROM)"` — check `emailError` in the create-share response or the resend endpoint's error body | `pages/api/admin/share.js:63-78` (create, non-fatal `emailError` field), `pages/api/admin/share-email.js:35-46` (resend, 502 on failure) | `RESEND_API_KEY` or `EMAIL_FROM` unset (`emailEnabled()` false), or `EMAIL_FROM`'s sending domain isn't verified in Resend | Check `emailEnabled()` gating in `lib/email.js:10-12`. Set/verify `RESEND_API_KEY` and `EMAIL_FROM` in Vercel; verify the `EMAIL_FROM` domain in the Resend dashboard; redeploy. The share link itself is never lost — email failure is non-fatal by design, admin can copy the link or hit "Email / Resend" once fixed | README "Email delivery of share links"; `lib/email.js:10-12,31-58`; `pages/api/admin/share.js:61-78` |
| Share link shows "This private link has expired or doesn't exist" unexpectedly | No server error — `getShare()` returned null | `pages/watch/[shareId].js` | Three possibilities: (1) TTL elapsed (`DEFAULT_SHARE_HOURS=72`, max `MAX_SHARE_HOURS=720`); (2) admin revoked it from the Shares tab; (3) the id in the URL is malformed and fails `isShareId()`'s shape check before Redis is even queried | Check the Shares tab for the link's actual expiry/revoked state (admin view). If the id looks truncated or altered (not `16-64` chars of `[A-Za-z0-9_-]`), it was corrupted in transit/copy-paste, not actually expired | `lib/shares.js:13-15` (`isShareId` regex), `:43-46` (`getShare` returns null on any miss), `:61-67` (`revokeShare`); `pages/watch/[shareId].js:3-4` (doc comment), `:81-83` (the exact UI string) |
| Resume / "Continue watching" doesn't restore playback position | No server error necessarily — check browser DevTools Network tab for `/api/progress` calls | `pages/api/progress.js`, `components/ResumablePlayer.js` | `ResumablePlayer` depends on the `player.js` protocol being exposed by the bunny.net embed; if that handshake fails, resume silently does nothing (by design — playback still works) | Confirm in the browser console/network tab that `GET /api/progress?videoId=...` and periodic `POST /api/progress` calls are happening. If `player.js`'s dynamic import or the `player.on("ready", ...)` handshake never fires, it's a client-side embed compatibility issue, not a backend bug — playback itself is unaffected | README "Common issues" ("Resume doesn't work"); `components/ResumablePlayer.js:25-62` (all wrapped in try/catch that degrades silently) |
| A video stays stuck on "Processing" indefinitely in the admin Videos tab | No app error — `status` field reflects bunny.net's own encode state | `pages/api/admin/videos.js:29` via `videoState()` | bunny.net status codes: `videoState()` maps `5` (error) and `6` (upload failed) to `"failed"`, `4` and `7+` (already-playable JIT states) to `"ready"`, and everything else (`0`-`3`) to `"processing"`. If it's genuinely stuck at `2`/`3` for a long time, that's a bunny.net-side encode issue, not app logic | Check the video's `status`/`encodeProgress` fields returned by `GET /api/admin/videos` (or the bunny.net dashboard directly) to see the raw numeric status. If it reads `5` or `6`, the UI should already show "failed" — if it's stuck at `2`/`3`, this is a bunny.net encoding problem outside app control | `lib/bunny.js:135-143` (status code map, comment lines 135-136) |
| `429` response with a `"Too many ..."` message | `"Too many uploads started — try again shortly"` / `"Too many share links created — try again shortly"` / `"Too many requests — slow down a little"` — no `console.error` (rate limiting isn't an error, it's working as intended) | `pages/api/admin/upload.js:15-19` (30/hour per admin), `pages/api/admin/share.js:20-24` (30/hour per admin), `pages/api/videos.js:18-20` (60/minute per viewer) | Sliding-window limiter (`lib/ratelimit.js`) tripped for that identity+action. This is expected behavior under bursty use, not a bug | Confirm the limit/window against the three call sites above (these are the only three rate-limited endpoints in the app as of this writing — verify with `grep -rn allowRequest pages/api/`). If a legitimate workflow is hitting it, that's a product/limits decision, not a fix — route to whoever owns the limits, don't silently loosen them (fail-open failure semantics must stay unchanged, see `change-control` rule 12) | `lib/ratelimit.js:1-2` (fails open, by design); `change-control` non-negotiable #10, #12 |
| Deploy fails during `npm install` | Vercel/CI install step errors, not an app log | build step | A stray lockfile (`package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`) got committed despite being gitignored, or `package.json` was hand-edited to a version range that no longer resolves (peer-dependency mismatch) | `git ls-files \| grep -iE 'package-lock\|yarn.lock\|pnpm-lock'` should return nothing — if it doesn't, that file must go. Otherwise this is a dependency resolution problem — route to `dependency-currency` | README "Common issues"; `change-control` non-negotiable #4 |
| Build passes locally but fails in CI (or vice versa) | CI's "Build" step fails while `npm run build` succeeds on your machine, or vice versa | `.github/workflows/ci.yml` build step | Two independent causes: (a) a **new build-time env read** was added to the app but no matching dummy was added to `ci.yml`'s `env:` block (currently: `AUTH0_SECRET`, `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `APP_BASE_URL`, `ADMIN_EMAILS`, `BUNNY_LIBRARY_ID`, `BUNNY_API_KEY`, `BUNNY_TOKEN_AUTH_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`); or (b) no lockfile means CI's fresh `npm install` can resolve a different dependency version than what's on your machine | For (a): add the new env var with a dummy value to `.github/workflows/ci.yml`'s build `env:` block, matching the pattern already there. For (b): this is version drift, not a code bug — route to `dependency-currency` | `.github/workflows/ci.yml:16-46`; `change-control` Gate 3 and section 5 table |

---

## 3. Traps (things that look like fixes but aren't)

- **Fixing the symptom without reading the log line.** Every catch block in `pages/api/**`
  logs before it returns a 5xx (rule added in `1e01860` specifically because the previous
  behavior — swallow the error, return a generic message — made a Redis misconfiguration
  undiagnosable). If you find yourself editing code before you've read the actual
  `console.error` output for the failing request, stop and go read it first.
- **Forgetting that env-var changes need a redeploy.** Vercel only applies environment
  variable changes to *new* deployments (README: "After adding or changing any variable,
  redeploy — changes only apply to new deployments"). Setting the right value and then not
  redeploying looks identical, from the outside, to the fix not working.
- **Assuming CI's dependency versions match what's actually deployed.** There is no
  lockfile, by design (latest-versions doctrine). `npm install` in CI and `npm install` in a
  Vercel build can each resolve slightly different versions within the same `package.json`
  caret ranges, at different times. A green CI run doesn't guarantee the exact same
  dependency tree ships. If a bug appears only in production, don't assume "but CI passed"
  rules it out.
- **Cache confusion from the 4-second video-list cache.** `lib/bunny.js`'s `listAllVideos()`
  caches the bunny.net video list per warm serverless instance for 4 seconds
  (`VIDEO_LIST_CACHE_TTL_MS`). Two requests landing on different warm instances within that
  window can legitimately show slightly different lists (e.g. right after an admin uploads
  or deletes a video). This is not a bug — every mutation calls
  `invalidateVideoListCache()`, but the *instance that served your next read* may not be the
  same one that made the mutation. Wait a few seconds and recheck before treating a
  transient inconsistency as a data-loss bug.

---

## 4. Where logs land

| Source | Where to look | Notes |
|---|---|---|
| Local dev | The terminal running `npm run dev` | `console.error` prints directly; also shows Next.js compile errors |
| Vercel production | Vercel dashboard → project → **Logs** (all functions) or **Functions** (per-route) | This is where every `console.error("<label>:", err)` from `pages/api/**` lands in production — the primary tool for section 2's symptom table |
| Sentry | Only relevant if `SENTRY_DSN` (server/edge) or `NEXT_PUBLIC_SENTRY_DSN` (client) is set — check `sentry.server.config.js`, `sentry.edge.config.js`, `instrumentation-client.js`, all of which no-op silently if the DSN env var is absent | `instrumentation.js` wires `register()` (loads the server/edge config based on `NEXT_RUNTIME`) and `onRequestError` (forwards uncaught request errors to Sentry via `captureRequestError`) — but only fires if Sentry actually initialized |
| Browser console + Network tab | DevTools in the user's browser | Needed for client-only issues: resume/progress calls (`ResumablePlayer.js`), thumbnail 403s, Auth0 redirect chains |
| GitHub Actions CI logs | The PR's "Checks" tab, or `gh run view` / `gh api repos/<owner>/<repo>/actions/runs` | `.github/workflows/ci.yml` runs lint → test → build on Node 22; each step's full output is here, including the exact `npm install` resolution that CI got |

---

## Provenance and maintenance

Written 2026-07-13 against commit `8dcb237` (v1.6.0, first release 2026-07-07). Every
`console.error` label in section 2 was extracted directly from the repo with the command
below — re-run it before trusting this file if the codebase has moved on:

```bash
grep -rn "console.error" pages/api --include="*.js"
```

| Volatile claim | Re-verify with |
|---|---|
| Every admin catch logs before its 5xx (rule from `1e01860`) | `grep -L "console.error" pages/api/admin/*.js` (expect no output — a hit means a route is missing the log) |
| `envBySuffix()` still resolves prefixed Redis vars | `sed -n '11,19p' lib/redis.js` |
| Key prefix is `fablevideo:`, old `pvp:` data unmigrated | `grep -n 'PREFIX' lib/redis.js`; confirm with `diagnostics-and-tooling` against live Redis |
| Auth0 v4 routes at `/auth/*`, not `/api/auth/*` | `grep -n "auth0" proxy.js`; README "Upgrading from an older deployment" note |
| Rate limits: upload 30/h, share 30/h, videos 60/m | `grep -rn allowRequest pages/api/` |
| bunny.net status code map (5/6 = failed) | `sed -n '135,143p' lib/bunny.js` |
| CI build env dummies match app's required env vars | `sed -n '16,46p' .github/workflows/ci.yml` |
| 4-second video-list cache TTL | `grep -n VIDEO_LIST_CACHE_TTL_MS lib/bunny.js` |
| Sentry is inert without a DSN | `grep -n SENTRY_DSN sentry.server.config.js sentry.edge.config.js instrumentation-client.js` |
| Test/lint/build baselines (for ruling out "is this a real regression") | see `change-control` Gate 1-3 |

Unresolved / not independently re-verified in this pass: whether any `pvp:*` keys currently
exist in the live production Redis (this file only establishes that the *risk* is real from
the commit history — confirming actual orphaned data requires a live Redis inspection via
`diagnostics-and-tooling`, which this agent did not have access to run).
