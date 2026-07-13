---
name: diagnostics-and-tooling
description: Measure instead of eyeball — scripts and recipes for checking Marine Video Portal service health directly instead of guessing. Load when verifying environment variables actually resolved at runtime, inspecting production Redis key counts, checking bunny.net library/video status, debugging a playback-token or embed-URL mismatch, timing a page or measuring payload size, counting how many Redis commands a route costs, or when a symptom isn't in debugging-playbook's table and you need ground truth before changing code. Trigger phrases: "measure", "check env", "is Redis configured", "inspect Redis", "verify token", "sign embed URL", "how many Redis calls", "bunny library status", "orphaned pvp keys", "before guessing".
---

# Diagnostics and tooling — Marine Video Portal

The owner's doctrine for this repo: **measure instead of eyeball.** The audience for most
changes here is a zero-context, lower-capability model with no memory of yesterday's
debugging session — it cannot "just check" whether an env var is set or whether Redis has
stale data by feel. This skill ships four small, read-only Node scripts that answer those
questions with a real command instead of an assumption, plus a set of measurement recipes
that need no script at all.

Every script in `scripts/` is a runnable `.mjs` file, not documentation-only pseudocode. Run
them from the repo root exactly as shown — every invocation in this file was actually
executed to produce the output blocks quoted below.

## When NOT to use this skill

| You are trying to... | Use instead |
|---|---|
| Match a known user-visible symptom (502, login loop, 403, stuck upload...) to a root cause | `debugging-playbook` — its symptom table is the first stop; come here only when nothing matches or you need to confirm the root cause with a measurement |
| Understand *why* the architecture is shaped this way | `architecture-contract` |
| Respond to a CodeQL alert or suspected secret leak | `security-response` |
| Add, change, or document an environment variable's purpose | `environment-and-config` (this skill only *checks* what's resolved; that skill explains what each var does and how to set it) |
| Deploy, redeploy, or read Vercel/GitHub Actions logs end-to-end | `run-and-operate` |
| Decide what counts as a passing test or add test coverage | `validation-and-qa` |
| Look up bunny.net/Auth0/Upstash/Resend behavior in general | `domain-reference` |
| Know which gates a change needs before opening a PR | `change-control` |
| Investigate a past incident's full history | `failure-archaeology` |

If you already know the fix and just need to apply it, this skill isn't necessary — it exists
for the gap between "something might be wrong" and "I know what's actually true right now."

---

## 1. The scripts

All four live in `scripts/` and share `scripts/_lib.mjs` (not a standalone entry point — a
~100-line helper providing `.env.local` loading, the same env-var suffix resolution
`lib/redis.js` uses, safe value masking, and a read-only Redis proxy). Run any script with
`node .claude/skills/diagnostics-and-tooling/scripts/<name>.mjs` from anywhere — each resolves
the repo root from its own file location, not from your current directory.

**Common behavior across all four:** load `.env.local` from the repo root if present (without
overriding real env vars already set — same precedence Next.js uses); never print a secret's
full value (only a 3-character prefix + `***` + length, via `mask()` in `_lib.mjs`); exit
non-zero on any failure with a human-readable message, never a raw stack trace; make zero
network calls in the "not configured" path.

You'll see this stderr line on some runs — it's expected and harmless, not a bug:

```
(node:NNNN) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///.../lib/redis.js is
not specified and it doesn't parse as CommonJS. Reparsing as ES module because module syntax
was detected. This incurs a performance overhead.
```

It appears because `check-redis.mjs`, `check-bunny.mjs`, and `sign-embed.mjs` `import` directly
from the repo's own `lib/redis.js` / `lib/bunny.js` for fidelity (same code the app runs), and
`package.json` has no `"type": "module"` field (by design — see `dependency-currency` /
`change-control`). Node 22 detects the ESM `import` syntax in those files and reparses
correctly; this warning is Node telling you it did that, not an error.

### 1.1 `check-env.mjs` — environment variable inventory

**Purpose:** resolve and report every env var the portal reads (per README.md's
"Environment variables" section and `environment-and-config`'s reference template), flagging
what's missing and what degraded mode that missing var causes.

**Invocation:**
```bash
node .claude/skills/diagnostics-and-tooling/scripts/check-env.mjs
```

**Real captured output (unconfigured — nothing set, no `.env.local`, run 2026-07-13):**
```
check-env — Marine Video Portal environment inventory
=====================================================
repo root: /home/user/fable-video
.env.local: not found (fine if running in a shell that already exports the vars, e.g. Vercel/CI)

-- Required --
[MISSING] AUTH0_SECRET                             -                    session cookie encryption key
[MISSING] AUTH0_DOMAIN                             -                    Auth0 tenant domain (no scheme)
[MISSING] AUTH0_CLIENT_ID                          -                    Auth0 application client id
[MISSING] AUTH0_CLIENT_SECRET                      -                    Auth0 application client secret
[MISSING] APP_BASE_URL                             -                    exact site URL, no trailing slash
[MISSING] ADMIN_EMAILS                             -                    comma-separated admin allowlist
[MISSING] BUNNY_LIBRARY_ID                         -                    bunny.net Stream library id
[MISSING] BUNNY_API_KEY                            -                    bunny.net Stream library API key
[MISSING] BUNNY_TOKEN_AUTH_KEY                     -                    bunny.net embed view token auth key
[MISSING] KV_REST_API_URL | UPSTASH_REDIS_REST_URL -                    Redis connection URL
[MISSING] KV_REST_API_TOKEN | UPSTASH_REDIS_REST_TOKEN -                    Redis connection token

-- Optional (degraded mode if missing) --
[unset]   BUNNY_CDN_HOSTNAME           -                    pull-zone host
  ... (11 optional vars total, all [unset])

-- Degraded-mode warnings --
  - BUNNY_CDN_HOSTNAME missing -> thumbnails disabled -> homepage falls back to a title list
  - RESEND_API_KEY missing -> share emails disabled -> admins must copy links manually
  ... (10 warnings total)

-- Summary --
Required vars missing: 11 / 11
Optional degraded-mode warnings: 10

RESULT: NOT READY — one or more required env vars are missing. See [MISSING] rows above.
```
Exit code: `1`.

**Real captured output (with synthetic placeholder values — NOT real credentials — set inline
to demonstrate the "configured" path and suffix-matching, e.g.
`fablevideo_KV_REST_API_URL` instead of plain `KV_REST_API_URL`, simulating Vercel's
multi-store prefixing):**
```
-- Required --
[OK]      AUTH0_SECRET                             aaa***...*** (len=64) session cookie encryption key
[OK]      KV_REST_API_URL | UPSTASH_REDIS_REST_URL htt***...*** (len=23) via fablevideo_KV_REST_API_URL
[OK]      KV_REST_API_TOKEN | UPSTASH_REDIS_REST_TOKEN dem***...*** (len=19) via fablevideo_KV_REST_API_TOKEN
...
-- Summary --
Required vars missing: 0 / 11
Optional degraded-mode warnings: 9

RESULT: all required env vars resolved.
```
Exit code: `0`. Note the `via fablevideo_KV_REST_API_URL` source annotation — this is exactly
how you'd confirm the suffix-matching fallback (debugging-playbook's Redis-env-var symptom
row) actually fired.

**Safety:** read-only against the filesystem and `process.env` only; no network calls.

### 1.2 `check-redis.mjs` — Redis key census

**Purpose:** connect to Upstash Redis the same way `lib/redis.js` does, `PING`, then `SCAN`
(cursor loop, `COUNT 100`, read-only) the whole keyspace once, bucketing every key by its
`fablevideo:<family>` second segment and separately counting orphaned `pvp:*` keys — the
un-migrated data from the 2026-07-09 prefix rename (commit `075ad3e`, see
`failure-archaeology`).

**Invocation:**
```bash
node .claude/skills/diagnostics-and-tooling/scripts/check-redis.mjs
```

**Real captured output (unconfigured):**
```
check-redis — Marine Video Portal Redis census
==============================================
repo root: /home/user/fable-video

STATUS: not configured — cannot connect.
  KV_REST_API_URL / UPSTASH_REDIS_REST_URL:     MISSING
  KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN: MISSING

Set these in .env.local (see .claude/skills/environment-and-config) and re-run.
```
Exit code: `1`. No connection attempted.

**Verified output shape (against a local mock Upstash-REST server standing in for a real
Upstash database — NOT real production data, since no credentials exist in this environment;
seeded with 12 synthetic `fablevideo:*` keys across all known families plus 3 synthetic
`pvp:*` keys to exercise the orphan-detection path):**
```
PING -> PONG

-- Key census (15 total keys scanned) --
Prefix: fablevideo:
  fablevideo:settings   1
  fablevideo:viewers    1
  fablevideo:lastseen   1
  fablevideo:order      1
  fablevideo:theme      1
  fablevideo:progress   2
  fablevideo:share      2
  fablevideo:shares     1
  fablevideo:audit      1
  fablevideo:rl         1

*** WARNING: 3 orphaned pvp:* key(s) found. ***
These predate the 2026-07-09 prefix rename (pvp: -> fablevideo:, commit 075ad3e) and were
never migrated. The app no longer reads them, but the data is stranded in production.
Counts only shown above — no key names or values printed (may contain viewer emails).

RESULT: census complete.
```
Exit code: `0` (finding `pvp:*` orphans is a report, not a script failure — see the WARNING
line for the actual signal). Against real production Redis, expect `pvp:* orphans: 0` **or**
a nonzero count — the common-context brief for this repo explicitly flags that orphaned
`pvp:*` keys may exist post-rename and were never independently confirmed live.

**Why counts only, never key names:** `lib/store.js`'s `getProgress(email)` builds the key
`k("progress", email)` — the viewer's **email address is embedded in the key name itself**,
not just the value (`lib/store.js:92-94`). `lib/ratelimit.js`'s rate-limit keys similarly embed
the identity passed to `allowRequest` (an email, in every current call site). Printing raw
scanned key names would leak PII even without ever reading a value. This script enforces
"counts only" both by never calling anything that returns a value (only `scan`, which returns
key names, and this script discards everything past the family segment) and via the
`readOnlyRedis()` proxy in `_lib.mjs`, which throws on any command outside
`ping/scan/hgetall/get/ttl/type/dbsize` — verified directly:
```
$ node -e '... call r.set("fablevideo:test","x") through the wrapper ...'
OK, blocked as expected: refusing to call redis().set() — not in the read-only allowlist
(ping, scan, hgetall, get, ttl, type, dbsize). This script is read-only by design.
```
`FLUSHALL`/`FLUSHDB`/`DEL`/`UNLINK`/`SET`/`HSET`/etc. all throw before reaching the network —
enforced in code, not left as a comment promise.

### 1.3 `check-bunny.mjs` — bunny.net Stream library health

**Purpose:** call the same `listVideos()` the app uses (`GET
/library/{id}/videos?page=1&itemsPerPage=100`) and report `totalItems` plus a breakdown by
bunny.net's Stream status code: `0` created, `1` uploaded, `2` processing, `3` transcoding,
`4` finished, `5` error, `6` upload failed, `>6` = JIT states (already playable) — see
`lib/bunny.js`'s `videoState()` comment.

**Invocation:**
```bash
node .claude/skills/diagnostics-and-tooling/scripts/check-bunny.mjs
```

**Real captured output (unconfigured):**
```
check-bunny — bunny.net Stream library health
=============================================
repo root: /home/user/fable-video

STATUS: not configured — no request made.
  BUNNY_LIBRARY_ID: MISSING
  BUNNY_API_KEY:    MISSING

Set these in .env.local (see .claude/skills/environment-and-config) and re-run.
```
Exit code: `1`. No request made.

**Real captured output (auth-failed — a genuine GET to `https://video.bunnycdn.com` with an
intentionally invalid `BUNNY_API_KEY`, i.e. a real network round trip against bunny.net's real
API, not a mock):**
```
STATUS: auth failed (HTTP 403) — check BUNNY_API_KEY and BUNNY_LIBRARY_ID.
```
Exit code: `1`. (bunny.net returned `403`, not `401`, for a bad key — the script treats both
as "auth failed"; see the code's `err.status === 401 || err.status === 403` check.)

**Expected output shape (with real credentials, success — not run, no real key available in
this environment):**
```
totalItems (library-wide): 42

-- Status breakdown (first 42 of 42 items) --
  0   created        1
  4   finished       38
  5   error          2
  6   upload failed  1

RESULT: connected, library reachable.
```
Exit code: `0` — even with videos in `error`/`upload failed` states, a successful API call
exits `0` (that's a report about the library, not a script failure). A **network-failed** path
(DNS/TLS/timeout, no HTTP response at all) reports `STATUS: network failed — <message>` and
exits `1`; not independently triggered in this environment (would require breaking DNS/network
to bunny.net, which risks side effects on other tooling in this session).

**Safety:** a single `GET`. Never calls `createVideo`/`updateVideo`/`deleteVideo` or any other
mutating export from `lib/bunny.js`.

### 1.4 `sign-embed.mjs` — recompute a bunny.net embed token

**Purpose:** debug a playback-token mismatch by recomputing the exact signed embed URL
`lib/bunny.js`'s `signEmbedUrl()` would produce — `token =
SHA256_hex(BUNNY_TOKEN_AUTH_KEY + videoId + expires)` — and printing it alongside the expiry,
so you can diff it against what the app actually served (browser network tab or Vercel logs).

**Invocation:**
```bash
node .claude/skills/diagnostics-and-tooling/scripts/sign-embed.mjs <videoId> [ttlSeconds]
# ttlSeconds defaults to 10800 (3h), matching lib/bunny.js
```

**Real captured output (no `videoId` argument):**
```
USAGE: node scripts/sign-embed.mjs <videoId> [ttlSeconds]

  <videoId>    required — the bunny.net video GUID (see the id field in
               check-bunny.mjs output, or the /watch/<id> URL).
  [ttlSeconds] optional — defaults to 10800 (3h), matching lib/bunny.js.
```
Exit code: `1`.

**Real captured output (unconfigured, `videoId` given):**
```
STATUS: not configured — refusing to sign without both vars.
  BUNNY_TOKEN_AUTH_KEY: MISSING
  BUNNY_LIBRARY_ID:     MISSING

Set these in .env.local (see .claude/skills/environment-and-config) and re-run.
```
Exit code: `1`. No hash computed.

**Real captured output (synthetic, non-production credentials
`BUNNY_TOKEN_AUTH_KEY=testTokenAuthKey123 BUNNY_LIBRARY_ID=123456`, `videoId=demo-video-guid-abc`,
`ttlSeconds=60` — pure computation, no network, so this is a genuine full run, not a mock):**
```
using credentials: BUNNY_TOKEN_AUTH_KEY (tes**************** (len=19)), BUNNY_LIBRARY_ID=123456

videoId:  demo-video-guid-abc
ttl:      60s (0.02h)
expires:  1783913019  (2026-07-13T03:23:39.000Z)
embed URL:
  https://iframe.mediadelivery.net/embed/123456/demo-video-guid-abc?token=98f154558ccada7db045cf7668342450e83a0dcd8c486aaf08eb0d50b88c9077&expires=1783913019&autoplay=false
```
Exit code: `0`. Cross-checked independently with a bare `crypto.createHash("sha256")` call on
`tokenAuthKey + videoId + expires` outside the script — identical 64-hex-char digest, confirming
the script's formula matches `lib/bunny.js:145-155` exactly (import, not reimplementation).

**Safety:** pure computation (`crypto.createHash`), zero network calls. Never prints
`BUNNY_TOKEN_AUTH_KEY`'s value — only its masked length in the "using credentials" line. The
full embed URL (including its derived token) *is* the intended output — it's a short-lived,
single-purpose derived value, not the underlying secret.

---

## 2. Measurement recipes (no script needed)

### 2.1 Time a page load

```bash
curl -o /dev/null -s -w 'dns:%{time_namelookup}s connect:%{time_connect}s ttfb:%{time_starttransfer}s total:%{time_total}s http:%{http_code}\n' https://<your-deployment>.vercel.app/
```
Each `%{...}` is a literal curl write-out variable — `time_namelookup` (DNS), `time_connect`
(TCP+TLS connect), `time_starttransfer` (time to first byte, i.e. server processing time),
`time_total` (full request), `http_code` (status). A healthy homepage load on Vercel's edge
should show `ttfb` well under 1s once warm; a `ttfb` spike with `dns`/`connect` flat points at
server-side work (likely the bunny.net library fetch on a cold cache — see 2.2), not network.

### 2.2 Count a route's Redis command cost (worked example: `GET /api/videos`)

Traced directly from the source, 2026-07-13, for an **approved non-admin viewer** hitting a
**warm** bunny.net video-list cache (`pages/api/videos.js` → `lib/guard.js` →
`lib/ratelimit.js` → `lib/videoList.js` → `lib/store.js`):

| Step | Call | Redis command | Count |
|---|---|---|---|
| 1 | `requireApproved` → `isApprovedViewer(email)` (`lib/store.js:80-82`) | `HEXISTS fablevideo:viewers <email>` | 1 |
| 2 | `requireApproved` → `stampLastSeen(email)` (`lib/store.js:84-88`) | `HSET fablevideo:lastseen <email> <iso>` | 1 |
| 3 | `allowRequest("videos", email, 60, "1 m")` (`lib/ratelimit.js:23-29`) | 1 `EVALSHA`/`EVAL` sliding-window Lua script call (`@upstash/ratelimit`'s `safeEval`, `node_modules/@upstash/ratelimit/dist/index.mjs:147-152`) | 1 |
| 4 | `fetchVideoLibrary` → `listAllVideos()` (`lib/bunny.js`) | **0** — this is a bunny.net HTTP call behind a 4-second in-process cache, not Redis | 0 |
| 5 | `fetchVideoLibrary` → `getOrder()` (`lib/store.js:24-27`) | `GET fablevideo:order` | 1 |
| 6 | `fetchVideoLibrary` → `getSettings()` (`lib/store.js:9-18`) | `HGETALL fablevideo:settings` | 1 |

**N = 5 Redis commands** per `GET /api/videos` request from an approved non-admin viewer.

For an **admin** viewer, `isAdmin(email)` short-circuits `requireApproved` before steps 1-2
(`lib/guard.js:25` — `if (isAdmin(email)) return email;`), so admins skip the `HEXISTS` and
`HSET`: **N = 3** (rate-limit + `GET` + `HGETALL`).

Use this same trace method for any other route: open the handler, follow every function call
into `lib/store.js`/`lib/shares.js`/`lib/audit.js`/`lib/ratelimit.js`, and count each
`redis()....` call — don't estimate, count the actual call sites.

### 2.3 Measure homepage payload size

```bash
curl -so /dev/null -w '%{size_download} bytes, http %{http_code}\n' https://<your-deployment>.vercel.app/
```
`size_download` is the total bytes of the response body actually transferred. Compare before
and after a change that touches the homepage (e.g. a new admin-configurable field, a bigger
`videoCount`) to see the real cost, not a guess. For the JSON payload specifically (not the
HTML shell), hit the API route directly:
```bash
curl -so /dev/null -w '%{size_download} bytes\n' https://<your-deployment>.vercel.app/api/videos
```
(This requires an authenticated session cookie in practice, since `/api/videos` is gated by
`requireApproved` — grab the cookie from a logged-in browser's DevTools if you need this
against a real deployment.)

### 2.4 Watch Vercel function logs for a specific label

No CLI is assumed here — use the dashboard. Vercel → your project → **Logs** (all functions)
or **Functions** tab (per-route) → use the filter/search box for the exact `console.error`
label text (e.g. `"Could not load videos from bunny.net:"` — every label is a literal string
grepped from `pages/api/**`, per `debugging-playbook` section 2). Filter by route path or time
window to narrow further. If `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` are set, the same errors
also land in the Sentry project — `check-env.mjs` reports whether those vars are configured.

---

## 3. When to measure what

Cross-linked with `debugging-playbook`'s symptom table — that skill tells you *which row*
matches your symptom; this table tells you *what to run* to confirm the root cause it names
instead of taking it on faith.

| Symptom class | Run this | What it confirms |
|---|---|---|
| Admin tabs all 502, Redis suspected (debugging-playbook row 1) | `check-env.mjs` then `check-redis.mjs` | Whether `KV_REST_API_*`/`UPSTASH_*` actually resolved (including via suffix match) and whether the resolved credentials actually `PING` |
| Admin data looks "reset" or empty, `pvp:*` orphan suspected (debugging-playbook row 2) | `check-redis.mjs` | Live orphaned-key count under `pvp:*` — confirms or rules out the un-migrated-data theory with a real number, not speculation |
| Login loop / "callback URL mismatch" (debugging-playbook row 3) | `check-env.mjs` | Whether `AUTH0_*`/`APP_BASE_URL` are actually set (this script does not validate Auth0-side callback URL config — that's dashboard-only, see `environment-and-config`) |
| "Approved but sees 403" for a specific viewer (debugging-playbook row 4) | *(no script — see limitation below)* | Not covered here by design: confirming one viewer's exact stored email requires reading a value, and `check-redis.mjs` deliberately never prints values or key names (PII). Use the admin `/admin` → Viewers UI directly |
| Homepage shows title list, no thumbnails (debugging-playbook row 5) | `check-env.mjs` | Whether `BUNNY_CDN_HOSTNAME` is set (its absence is the entire cause per `lib/bunny.js`'s `thumbnailsEnabled()`) |
| Upload 401 on the TUS transfer (debugging-playbook row 7) | `check-env.mjs` | Whether `BUNNY_API_KEY`/`BUNNY_LIBRARY_ID` are set and their reported length looks sane (a stray pasted newline changes the length) — this skill does not ship a TUS-signature recomputation script; `sign-embed.mjs` only covers the embed-token formula |
| Playback fails, suspect a stale/mismatched embed token | `sign-embed.mjs <videoId>` | Recompute the exact token the app should have produced and diff against what was actually served |
| A video stuck on "Processing" (debugging-playbook row 10) | `check-bunny.mjs` | The real numeric status code and whether the whole library's status distribution looks normal, not just one video in isolation |
| `429` rate-limit responses (debugging-playbook row 11) | `check-redis.mjs` (watch the `rl` family count) + recipe 2.2 | Whether the `fablevideo:rl:*` key family is growing as expected for the sliding window in use |
| "Is this endpoint slow, or does it feel slow" | Recipe 2.1 (`curl -w`) | Real `ttfb`/`total` numbers instead of a subjective impression |
| "Did my change make the payload bigger" | Recipe 2.3 | An actual byte count, before/after |
| Nothing in `debugging-playbook`'s table matches at all | `check-env.mjs` first (rule out config drift), then whichever of `check-redis.mjs`/`check-bunny.mjs` touches the failing subsystem | Ground truth on the two most common invisible-failure surfaces (env resolution, Redis connectivity) before treating it as a code bug |

---

## Provenance and maintenance

Written 2026-07-13 against commit `1be60d7` (v1.6.0, first release 2026-07-07). Every script
output block above was captured by actually running the script in this repo on this date,
except where explicitly labeled "expected output shape" or "not run" — those are documented
from reading `lib/bunny.js`/`lib/redis.js` directly, not invented from memory.

| Volatile claim | Re-verify with |
|---|---|
| Full required/optional env var inventory matches README | `node .claude/skills/diagnostics-and-tooling/scripts/check-env.mjs`, diff against README.md "Environment variables" |
| `envBySuffix()` logic in `_lib.mjs` still matches `lib/redis.js` | `sed -n '11,19p' lib/redis.js` vs `scripts/_lib.mjs`'s `envBySuffix` |
| Redis key families and their `k()` call sites | `grep -rn 'k("' lib pages \| grep -v __tests__` |
| `pvp:*` orphan risk is unconfirmed live (this skill did not have credentials to check real production Redis) | Run `check-redis.mjs` against real Vercel-injected env vars from within a Vercel environment or with real `.env.local` credentials |
| bunny.net status code map (0-6, >6=JIT) | `sed -n '135,143p' lib/bunny.js` |
| `signEmbedUrl` formula (`SHA256_hex(key+videoId+expires)`) | `sed -n '145,155p' lib/bunny.js` |
| `GET /api/videos` costs 5 Redis commands (viewer) / 3 (admin) | Re-trace `pages/api/videos.js` → `lib/guard.js` → `lib/ratelimit.js` → `lib/videoList.js` → `lib/store.js`; a code change to any of those files can change this count |
| `@upstash/ratelimit` issues 1 command per `.limit()` call via `EVALSHA` | `grep -n "safeEval\|evalsha" node_modules/@upstash/ratelimit/dist/index.mjs` |
| Node 22's ESM-reparse-of-typeless-`.js` behavior (the harmless warning) | `node --version` (must be >=22 for this fallback to exist); confirmed on `v22.22.2` in this environment |

Unresolved / not independently re-verified in this pass: whether any `pvp:*` keys currently
exist in the **real** production Redis (no live credentials were available in this
environment — `check-redis.mjs`'s orphan-detection path was verified against a local mock
server, not real Upstash data); the exact `network-failed` output of `check-bunny.mjs` (not
triggered, to avoid deliberately breaking network connectivity in this session); whether a TUS
upload-signature debugging script would be a useful fifth addition to this skill (flagged as a
gap in the routing table above, not built — out of the four scripts this task specified).
