---
name: validation-and-qa
description: What counts as EVIDENCE in this repo, how to add a test to lib/__tests__, and the acceptance discipline for claiming any change "works". Load when writing or changing tests, deciding whether a change is proven, defining done-criteria for a feature before coding, or evaluating whether a claim ("this fixes it", "this works now") is actually supported by something you ran.
---

# Validation and QA — Marine Video Portal

This skill is the repo's research-methodology mandate applied to a live production
app: the discipline that turns a hunch into an accepted result. A hunch becomes
evidence only by predicting an observation BEFORE running anything, then running it,
then comparing. Everything below exists to make that discipline mechanical enough
for a zero-context model to follow.

## When NOT to use this skill

| You are trying to... | Use instead |
|---|---|
| Know which gates a given file class requires, PR flow, non-negotiables | `change-control` |
| Understand system invariants / why the architecture is shaped this way | `architecture-contract` |
| Respond to a CodeQL alert or suspected vulnerability | `security-response` |
| Bump a dependency or fix an install failure | `dependency-currency` |
| Debug a runtime failure (500s, login loops, blank pages) | `debugging-playbook` |
| Understand a past incident or why a commit exists | `failure-archaeology` |
| Look up bunny.net/Auth0/Upstash/Resend domain specifics | `domain-reference` |
| Add/change environment variables or config files | `environment-and-config` |
| Deploy, redeploy, or run the app locally/in prod | `run-and-operate` |
| Set up local tooling or diagnostics | `diagnostics-and-tooling` |
| Write README/CHANGELOG/docs prose | `docs-and-writing` |
| Plan and ship a whole feature end to end | `feature-shipping-campaign` (this skill supplies its done-criteria step) |

Use **this** skill whenever you're about to write "tests pass" or "this fixes it" in
a PR description, a commit message, or a report to the user — before you write that
sentence, come here.

## 1. The evidence bar

A claim is evidence only if all four of these are true. If any is false, it is an
assertion, and you must say so plainly rather than let it pass as proof.

1. **You wrote the hypothesis and the exact predicted observation BEFORE running
   anything.** Not "lint should pass" — write the literal string you expect:
   "`npm run lint` prints only the two-line script banner and exits 0." "`npm test`
   ends with `Test Files  4 passed (4)` and `Tests  24 passed (24)`." "`POST
   /api/admin/share` returns `201` with a JSON body containing `id`."
2. **You ran the real command, fresh, in this checkout, after your change.** Not a
   memory of having run it earlier, not a run from before the edit, not a build in
   your head of what the code "obviously" does.
3. **You compared prediction to actual output and they matched.** A match is
   evidence. A mismatch means: stop, understand why, do not rationalize it away
   ("probably just flaky", "close enough") and do not silently loosen the
   prediction to fit what happened.
4. **You can paste the actual command output, not a reconstruction of it.** If you
   cannot show fresh output because you didn't run the command, the correct thing to
   write is "not verified" or "expected but unobserved" — never phrase reasoning as
   if it were an observation.

Two failure modes to name explicitly, because they are the common ways this
discipline gets faked:

- **Reasoning-as-evidence**: "I read `clampShareHours` and the logic looks right,
  so it works." Reading code produces a hypothesis, not a result. Run the test.
- **Pasting-expected-as-observed**: copying the "Expected output" block from this
  file (or from `change-control`) into a PR description or chat reply as if it were
  a terminal transcript. Those blocks are predictions for gates 2 (below); they are
  not a substitute for actually running the command in the current checkout.

Corollary for surprises: if a gate fails, or passes with output that doesn't match
what you predicted (extra warnings, different counts, a slower build), do not
re-run it hoping it clears up and do not narrate around it. Stop and diagnose —
route lint/test/build failures per `change-control` section 5.

## 2. The three gates

These are the repo's only automated evidence sources. `change-control` owns the
authoritative gate procedure (order, when each applies, PR flow); this section
restates the expected outputs so a testing decision doesn't require a second file
read. If the two ever disagree, trust `change-control` and flag the drift.

### Gate 1 — lint

```bash
npm run lint
```

Predicted: exactly the two-line script banner, then exit 0.

```
> marine-video-portal@1.8.0 lint
> eslint .
```

Verified fresh 2026-07-13 in this checkout: matched — exit 0, no extra output.

### Gate 2 — test

```bash
npm test
```

Predicted (current baseline — **a moving target, see Provenance below**):

```
 Test Files  7 passed (7)
      Tests  62 passed (62)
```

Verified fresh 2026-07-23 (after the `ADMIN_GEO_BYPASS_EMAILS` feature added 6 tests
to `geo.test.js`, still 7 files): matched. Note the file count has already drifted
past the "four files" language in section 3 below — `shares.test.js` and
`watermark.test.js` exist too but aren't yet in that table; treat section 3's map as
incomplete, not wrong about the files it does list. Full run also printed a
`Duration` line, which is informational, not part of the prediction — don't treat a
duration change as a failure.

To run a single new/changed file instead of the whole suite while iterating:

```bash
npx vitest run lib/__tests__/<file>.test.js
```

### Gate 3 — build

`npm run build` needs env vars. Reproduce CI's dummy-env build (one-liner sourced
from `.github/workflows/ci.yml`, reproduced in `change-control` section 2):

```bash
AUTH0_SECRET=6f0f2c9a4d1e8b37c5a2f4d6e8091b3d5f7a9c1e3b5d7f90a2c4e6081b3d5f70 AUTH0_DOMAIN=example.us.auth0.com AUTH0_CLIENT_ID=ci-client-id AUTH0_CLIENT_SECRET=ci-client-secret APP_BASE_URL=http://localhost:3000 ADMIN_EMAILS=admin@example.com BUNNY_LIBRARY_ID=1 BUNNY_API_KEY=ci-dummy-key BUNNY_TOKEN_AUTH_KEY=ci-dummy-token KV_REST_API_URL=https://ci-dummy.upstash.io KV_REST_API_TOKEN=ci-dummy npm run build
```

Predicted: exit 0 and a printed `Route (pages) ...` table listing every page and API
route.

**Do not run this yourself if other agents/tasks may be working in the same
checkout** — `next build` writes `.next/` and parallel builds collide. Cite the
orchestrator-verified baseline instead (build passed 2026-07-10 per `change-control`)
and let the PR's CI run be the authoritative build check for your change. Only run
it locally when you have the checkout to yourself.

## 3. Existing test map

Read fresh from the four files in `lib/__tests__/` on 2026-07-13 (all pass, see
above). This is the entire suite — there is no test coverage outside these four
files.

| File | Module under test | What it actually asserts | Example test name |
|---|---|---|---|
| `auth.test.js` | `lib/auth.js` — `isAdmin`, `isValidEmail`, `normalizeEmail`, `parseEmailList` | admin match is case-insensitive/trimmed; non-admin/empty/null/undefined all reject; unset `ADMIN_EMAILS` rejects everyone; email normalization lowercases+trims; plausible-address validation; list parsing splits on comma/semicolon/whitespace, dedupes case-insensitively, separates invalid entries, handles empty/null input | `"matches admin emails case-insensitively and trims whitespace"` |
| `email.test.js` | `lib/email.js` — `emailEnabled`, `siteName`, `escapeHtml`, `shareEmailTemplate` | email sending is gated on BOTH `RESEND_API_KEY` and `EMAIL_FROM` being set; site name defaults to "Marine Video Portal" and honors `SITE_NAME`; HTML metacharacters are escaped; the share email template embeds link/recipient/expiry in both html and text, escapes an HTML-bearing video title, and degrades to "expires soon" text on a malformed expiry date | `"escapes HTML in the video title"` |
| `order.test.js` | `lib/order.js` — `applyOrder` | videos sort by a saved id order; unplaced videos float to the top, newest first; order entries for deleted videos are ignored; empty order or empty video list is handled | `"floats unplaced videos to the top, newest first"` |
| `theme.test.js` | `lib/theme.js` — `PRESETS`, `isValidHex`, `resolveTheme`, `DEFAULT_PRESET` | exactly 7 presets, each with valid hex `accent`/`accent2`; hex validator accepts only `#RRGGBB` (rejects missing `#`, short/long forms, named colors, non-strings); `resolveTheme` falls back to the default preset for any junk input, resolves a named preset, accepts+lowercases valid custom colors, and falls back on an invalid custom color (e.g. a `javascript:` URL) | `"rejects invalid custom colors by falling back"` |

Pattern conventions to copy, observed across all four files:

- Import from `"vitest"` directly (no global test API): `import { describe, expect,
  it } from "vitest";` — add `beforeEach`/`afterEach` only if you mutate
  `process.env` (see below).
- Every module under test is pure: no I/O, no network, no Redis, no Auth0. Tests
  call the exported function and assert on its return value — no mocks anywhere in
  the suite today.
- `process.env` mutation is scoped and restored. `auth.test.js` sets
  `ADMIN_EMAILS` in a `beforeEach` (fresh value each test, no explicit teardown
  needed since every test sets it again or explicitly `delete`s it).
  `email.test.js` is stricter: it snapshots `RESEND_API_KEY`/`EMAIL_FROM`/
  `SITE_NAME` once at module load and restores them in `afterEach` — copy this
  snapshot-and-restore pattern for any test that reads env vars, since Vitest does
  not sandbox `process.env` between test files run in the same process.
- Assertions are plain-value (`toBe`, `toEqual`, `toContain`, `toHaveLength`) — no
  snapshot testing, no custom matchers.

## 4. How to add a test — runbook

1. **Confirm the module is pure** (no import of `lib/redis.js`, `lib/bunny.js`,
   `lib/auth0.js`, or anything that calls `fetch`/network at import or call time).
   If it isn't, this repo has no mocking harness yet — see section 5 before writing
   anything.
2. **Create the file at exactly `lib/__tests__/<module>.test.js`.** This MUST match
   `vitest.config.js`'s `include: ["lib/__tests__/**/*.test.js"]` glob verified in
   this checkout. A test anywhere else — `__tests__/` at repo root, `test/`,
   colocated `*.test.js` next to the source file — is silently never collected;
   `npm test` will report success without ever having run it. Verify placement with:
   ```bash
   npx vitest list | grep <module>
   ```
   (expect your new test names to appear in the list).
3. **Follow the existing skeleton** (copied from `lib/__tests__/order.test.js`, the
   simplest real file in the suite):
   ```js
   import { describe, expect, it } from "vitest";
   import { yourExport } from "../your-module";

   describe("yourExport", () => {
     it("describes one observable behavior in plain language", () => {
       expect(yourExport(/* plausible input */)).toEqual(/* expected value */);
     });
   });
   ```
   If the function reads `process.env`, add the snapshot/`afterEach` restore pattern
   from `email.test.js` (section 3) rather than `beforeEach`-only mutation — it's
   the safer default when a test file might run alongside others in one process.
4. **Run just your file first**, predicting the pass count before you run it:
   ```bash
   npx vitest run lib/__tests__/<module>.test.js
   ```
5. **Run the full suite** and record the new totals:
   ```bash
   npm test
   ```
6. **Update the stated counts.** This file (section 2, Gate 2) and
   `change-control` (its Gate 2 section) both hardcode "4 files / 24 tests" as of
   2026-07-10. If your PR changes those numbers, update both files in the same PR —
   route the actual prose edit through `docs-and-writing` if the change is
   nontrivial, but the numeric baseline itself belongs to whoever adds the tests,
   not a follow-up docs pass.

## 5. What belongs where

**Unit-testable today** = pure functions in `lib/*.js` with no Redis/bunny/Auth0/
network touch at import or call time. Confirmed candidates that exist right now and
are untested — CANDIDATES, not verified work, do not claim they're covered until
someone writes the file per section 4:

- `clampShareHours(hours)` in `lib/shares.js:17-21` — pure arithmetic clamp
  (`DEFAULT_SHARE_HOURS` on non-finite/≤0 input, floors and bounds to
  `[1, MAX_SHARE_HOURS]` otherwise). Good first test: no env, no mocking, three or
  four boundary cases.
- `isShareId(id)` in `lib/shares.js:13-15` — pure regex check
  (`/^[A-Za-z0-9_-]{16,64}$/` on a string). Good first test: valid id, too-short,
  too-long, non-string, `null`/`undefined`.

**NOT unit-testable today** = anything importing `lib/redis.js`, `lib/bunny.js`,
`lib/auth0.js`, `lib/guard.js` (wraps auth0+store), `lib/audit.js`,
`lib/ratelimit.js`, `lib/store.js` (all confirmed by reading their top-of-file
imports: each pulls in `@upstash/redis`, `@upstash/ratelimit`, or `./auth0`) — and
by extension every `pages/api/**` route and every page's `getServerSideProps`,
since they all call into these modules. There is no mocking harness in this repo
today (`grep -rn vi.mock lib/ pages/` returns nothing, verified 2026-07-13).

Adding one is a **labeled candidate, unproven**: `vi.mock("../redis", () => ({ k:
(...p) => p.join(":"), redis: () => fakeClient }))` at the top of a test file, where
`fakeClient` is a hand-built object implementing whichever Redis methods the module
under test calls (`get`, `set`, `sadd`, `smembers`, `mget`, `del`, `srem`, `ttl`,
`hgetall`, `lpush`, `ltrim` are the ones in use across `lib/`, per the reads above).
This shape has not been built or run in this repo — do not present it as available
tooling, present it as a starting sketch for whoever picks up that work.

**Manual verification checklists** cover everything the automated gates and the
unit suite cannot reach — most of the app's actual behavior, since coverage today
is 4 pure-logic files against ~20 route/page files. Numbered click-paths, run
against a real deployment or `npm run dev` with real credentials
(`AUTH0_*`, `BUNNY_*`, `KV_REST_API_*`, optionally `RESEND_API_KEY`) — **be honest
that most of these require live infra, not dummy CI values; for local-vs-prod setup
route to `run-and-operate`**:

1. **Homepage** — load `/`; search filters the video list; a collection filter
   narrows results; pagination (if `videoCount` is exceeded) moves to a next page
   without duplicating/dropping videos.
2. **Watch + resume** — open a video, let it play a few seconds, navigate away,
   return: playback resumes near the last position (via `lib/store.js` progress
   tracking, `pages/api/progress.js`).
3. **Admin, each tab** (`pages/admin.js`, tabs confirmed in file: Videos, Viewers,
   Shares, Settings, Activity, Analytics) — load `/admin` as a non-admin (expect
   redirect/403 per rule 1 in `change-control`); load as an admin; exercise one
   mutating action per tab (reorder a video, approve/remove a viewer, create a
   share, change a setting, confirm it appears in Activity, confirm Analytics
   numbers move).
4. **Share flow end-to-end** (the security-sensitive one — cross-check
   `change-control` rule 8): admin creates a share for recipient A → email is sent
   (if configured) or link is copied manually → open the link logged in as A → see
   the video, `viewedAt` gets stamped → open the same link logged in as a
   *different* user B → see the generic "made for someone else" message, never A's
   address (per `pages/watch/[shareId].js:34-37`) → admin revokes the share → the
   link now shows "expired or doesn't exist" for anyone, including A.
5. **Upload** — admin uploads a small video file in the Videos tab → a processing
   badge appears → poll/wait until it flips to ready → the video appears in the
   public list once ready (and only once ready).

None of steps 1-5 has an automated stand-in today. Treat a "works" claim about any
of them as requiring a fresh manual run, not an inference from reading the route
code — same evidence bar as section 1.

## 6. Acceptance discipline for features

Feeds `feature-shipping-campaign`: write the done-criteria BEFORE writing code, not
after, so "done" isn't quietly redefined to match whatever got built. Template:

```
## Done-criteria: <feature name>

Behavior (plain sentences, written before coding):
- <what a user/admin observes, e.g. "an admin can set a share's TTL up to 30 days
  instead of the current 72h-only default">
- <edge cases explicitly in scope, e.g. "a TTL of 0 or negative falls back to the
  default, matching clampShareHours' existing behavior">

Gate evidence (paste fresh output, not predictions, once the change exists):
- [ ] npm run lint — <exit code + output>
- [ ] npm test — <Test Files / Tests line, and did counts change from baseline>
- [ ] npm run build — <exit code, or "not run, ceded to PR CI" with the reason>

Unit tests added (if the change touched pure lib/ logic):
- [ ] lib/__tests__/<file>.test.js added/extended, listed in `npx vitest list`

Manual checklist subset exercised (pick from section 5's list, only the ones this
feature actually touches):
- [ ] <checklist item> — <what was observed, by whom, when>

Non-negotiables re-checked (from change-control section 3, only the applicable rows):
- [ ] <rule # and one-line confirmation>
```

Evidence belongs **in the PR description**, in this shape, not only in chat — a
reviewer or a future debugging session needs to see the predicted-vs-observed pairs
without re-deriving them.

## 7. Regression rule

Any bug that reaches production and is unit-testable (pure `lib/*.js` logic, no
Redis/bunny/Auth0 touch) gets a regression test in the same fix PR, added per
section 4, asserting the specific input that broke. Route the incident's history
and root-cause writeup to `failure-archaeology` — that skill is the incident
ledger; this skill only owns making sure the fix is pinned down by a test so the
same input can't silently regress again. If the bug is in Redis/bunny/Auth0-touching
code (not unit-testable today per section 5), the regression protection is the
relevant manual checklist item in section 5 plus whatever `failure-archaeology`
records — say so explicitly rather than implying a test exists when it doesn't.

## Provenance and maintenance

Written 2026-07-13 against commit state matching `change-control`'s 2026-07-10
snapshot (v1.6.0). Verified fresh in this session, this checkout:

- `npm run lint` → exit 0, banner-only output (matched section 2's prediction).
- `npm test` → `Test Files  4 passed (4)` / `Tests  24 passed (24)` (matched).
- `npm run build` — NOT run in this session (avoided per the concurrency warning
  this file itself states); cites the same 2026-07-10 baseline as `change-control`.
- All four `lib/__tests__/*.test.js` files read in full; section 3's table is a
  direct summary of their actual `it(...)` blocks, not inferred from filenames.
- `lib/shares.js` read in full; `clampShareHours`/`isShareId` confirmed pure
  (no import beyond `crypto` and `./redis`, and `./redis` is only used by other
  exports in that file, not by these two functions).
- `lib/redis.js`, `lib/guard.js`, `lib/audit.js`, `lib/ratelimit.js`, `lib/store.js`,
  `lib/bunny.js` top-of-file imports read to confirm the "not unit-testable" list.
- `vitest.config.js` read directly; the include glob quoted in section 4 is
  verbatim.
- `pages/admin.js` grepped for tab names; `pages/watch/[shareId].js` read for the
  share-mismatch/expiry behavior cited in section 5, step 4.
- `grep -rn vi.mock lib/ pages/` returned no output — confirmed no mocking harness
  exists (section 5's "unproven" framing).

| Volatile claim | Re-verify with |
|---|---|
| Test baseline is 4 files / 24 tests | `npm test 2>&1 \| grep -E "Test Files\|Tests"` — **update section 2 and 3 of this file, and `change-control`'s Gate 2, in the same PR that changes this number** |
| Lint stays banner-only, exit 0 | `npm run lint; echo $?` |
| Test include glob is `lib/__tests__/**/*.test.js` | `cat vitest.config.js` |
| No mocking harness exists yet | `grep -rn "vi.mock" lib/ pages/` (expect no output; if it now has output, section 5 is stale — describe the real harness instead of the sketch) |
| `clampShareHours`/`isShareId` are still pure and untested | `grep -n "clampShareHours\|isShareId" lib/shares.js lib/__tests__/*.test.js` (expect defs in shares.js, no hits in `__tests__/`) |
| Admin tab list unchanged (Videos/Viewers/Shares/Settings/Activity/Analytics) | `grep -n "Tab(" pages/admin.js` |
| Share-mismatch message still hides the recipient | `sed -n '30,40p' pages/watch/\[shareId\].js` |
| CI gate order/env block unchanged | `cat .github/workflows/ci.yml` |
