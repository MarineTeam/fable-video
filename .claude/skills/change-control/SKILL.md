---
name: change-control
description: How changes are classified, gated, reviewed, and merged in the Marine Video Portal repo. Load BEFORE modifying any file here — covers the required checks (lint/test/build), the branch→PR→CI→merge flow, the non-negotiable rules with the incident behind each, and the pre-PR self-review checklist.
---

# Change control — Marine Video Portal

This repo is a live production app (currently v1.8.0, deployed on Vercel; first release
v1.6.0 on 2026-07-07).
Every change follows the same pipeline: **classify the change → run the gates → self-review
against the non-negotiables → feature branch → PR to main → CI green → merge → Vercel
auto-deploys main.** This file tells you exactly what each step means here.

Definitions used throughout:
- **Gate** — a command that must pass before a PR is opened. The three gates are
  `npm run lint`, `npm test`, and `npm run build` (same order CI runs them).
- **Non-negotiable** — a repo rule you never break without explicit owner sign-off. Each
  one exists because of a real incident or a security property; the table below cites the
  evidence (commit hash or file:line).

## When NOT to use this skill

| You are trying to... | Use instead |
|---|---|
| Understand system invariants / why the architecture is shaped this way | `architecture-contract` |
| Respond to a CodeQL/security alert or suspected vulnerability | `security-response` |
| Bump a dependency, fix an install/peer-dependency failure | `dependency-currency` |
| Debug a runtime failure (500s, login loops, blank pages) | `debugging-playbook` |
| Understand a past incident or why a commit exists | `failure-archaeology` |
| Look up bunny.net/Auth0/Upstash/Resend domain specifics | `domain-reference` |
| Add/change environment variables or config files | `environment-and-config` |
| Deploy, redeploy, or operate the running app | `run-and-operate` |
| Write or extend tests, decide what to test | `validation-and-qa` |
| Set up local tooling or diagnostics | `diagnostics-and-tooling` |
| Write README/CHANGELOG/docs prose | `docs-and-writing` |
| Plan and ship a whole feature end to end | `feature-shipping-campaign` |

Use **this** skill when you are about to edit any file and need to know which gates apply,
which rules are untouchable, and what the PR must look like.

## 1. Classify the change

Find your change class in this table. Run every listed gate. Consult the listed sibling
skill BEFORE writing code, not after.

| Class | What counts | Required gates | Consult first |
|---|---|---|---|
| Docs-only | `README.md`, `CHANGELOG.md`, comments, `.claude/skills/**` | none locally (CI still runs all three on the PR) | `docs-and-writing` |
| Pure lib logic | `lib/*.js` with no route/page changes | lint + test (add/update tests in `lib/__tests__/`) | `validation-and-qa` |
| API route | anything under `pages/api/**` | lint + test + build | `architecture-contract` (guard/logging/rate-limit patterns) |
| Page UI | `pages/*.js`, `pages/watch/**`, `components/`, `styles/` | lint + build (+ manual check via `run-and-operate`) | `feature-shipping-campaign` |
| Security-touching | `lib/auth.js`, `lib/guard.js`, `lib/shares.js`, token signing in `lib/bunny.js` (lines ~145–195), `pages/watch/[shareId].js`, `proxy.js` | ALL gates + full self-review checklist (section 4) | `security-response` AND `architecture-contract` |
| Config-env | `next.config.js`, `vitest.config.js`, `eslint.config.mjs`, env-var additions | lint + test + build; env-var changes ALSO need a Vercel redeploy | `environment-and-config`; redeploy via `run-and-operate` |
| Dependency bump | any edit to `package.json` deps | fresh `npm install`, then ALL gates | `dependency-currency` (latest-versions doctrine + the ESLint 9.x exception) |
| CI workflow | `.github/workflows/ci.yml` | lint + test locally; workflow itself is verified by the PR run | `security-response` (keep `permissions: contents: read` — added in 7968919 for CodeQL alert #1) |

If a change spans classes, apply the union of the gates and the strictest consult
(security-touching wins).

## 2. Run the gates

Run gates from the repo root `/home/user/fable-video`. `node_modules` is already installed
here; if commands fail with "module not found", run `npm install` first (no lockfile — that
is by design, see non-negotiables).

### Gate 1 — lint

```bash
npm run lint
```

Expected output — exactly this, then exit 0 (verify with `echo $?`):

```
> marine-video-portal@1.8.0 lint
> eslint .
```

No warnings, no errors, nothing after the script banner. Any extra output = failure.
Note: one rule (`react-hooks/set-state-in-effect`) is deliberately disabled with a
rationale comment in `eslint.config.mjs` (commit eef72fb). If lint flags something you
believe is a false positive, follow that pattern — never disable a rule without a comment
explaining why, and never disable one just to get a PR through.

### Gate 2 — tests

```bash
npm test
```

Expected output ends with (as of 2026-07-23):

```
 Test Files  7 passed (7)
      Tests  62 passed (62)
```

The counts `7` and `62` are the current baseline. **If your change adds tests, these
numbers go UP — update this file's counts in the same PR.** If they go DOWN or anything
reports `failed`, the gate failed. Tests live only in `lib/__tests__/` (auth, email,
order, theme, geo, shares, watermark — pure logic; API routes and pages have no test
coverage, so gates 1 and 3 are their only automated checks).

### Gate 3 — build

`npm run build` requires env vars to be present. CI uses dummy values (see
`.github/workflows/ci.yml` lines 35–46). Reproduce CI's build locally with this exact
one-liner (values copied from ci.yml):

```bash
AUTH0_SECRET=6f0f2c9a4d1e8b37c5a2f4d6e8091b3d5f7a9c1e3b5d7f90a2c4e6081b3d5f70 AUTH0_DOMAIN=example.us.auth0.com AUTH0_CLIENT_ID=ci-client-id AUTH0_CLIENT_SECRET=ci-client-secret APP_BASE_URL=http://localhost:3000 ADMIN_EMAILS=admin@example.com BUNNY_LIBRARY_ID=1 BUNNY_API_KEY=ci-dummy-key BUNNY_TOKEN_AUTH_KEY=ci-dummy-token KV_REST_API_URL=https://ci-dummy.upstash.io KV_REST_API_TOKEN=ci-dummy npm run build
```

Expected: exit 0 and a printed route table (`Route (pages) ...` listing every page and
API route). Verified passing on 2026-07-10.

**Concurrency warning:** `next build` writes to `.next/`. If other agents or tasks are
working in this same checkout, do NOT run the build in parallel — builds collide on
`.next/`. In that case cite the verified baseline (build passed 2026-07-10 with the env
block above) and let the PR's CI run be the authoritative build check.

### Then: branch → PR → CI → merge

The development convention observed in git history (all 12 commits):

1. Work on a **feature branch** (never commit directly to `main`).
2. Open a **PR to `main`**. CI (`.github/workflows/ci.yml`) runs lint → test → build on
   Node 22 with a fresh `npm install` (no lockfile, so CI resolves fresh within
   `package.json`'s caret ranges — a version drift can fail CI even when local passes;
   route that to `dependency-currency`).
3. Merge only when **CI is green**.
4. **Vercel deploys `main` automatically** after merge. No manual deploy step for code.
5. **Env-var changes are NOT deployed by a code merge** — after adding/changing a
   variable in Vercel you must trigger a redeploy (README line 143: "changes only apply
   to new deployments"). See `run-and-operate`.

## 3. Non-negotiables

Break none of these. Each row: the rule, why it exists, and where to verify it.

| # | Rule | Rationale / incident | Evidence |
|---|---|---|---|
| 1 | Every `/api/admin/*` route's handler begins with `const admin = await requireAdmin(req, res); if (!admin) return;` and thus returns 403 to non-admins | Double-gating doctrine: the `/admin` page is gated server-side AND every API route is gated independently — a UI bug can never expose an admin API | `lib/guard.js:1-2` (stated contract); all 11 files in `pages/api/admin/` comply; README "Security notes" |
| 2 | Every `catch` block logs `console.error("label:", err)` BEFORE returning a generic 5xx | Incident: before 1e01860, every data-layer catch swallowed its error — a Redis misconfiguration produced invisible generic 502s across the entire admin panel, undiagnosable from Vercel logs | commit 1e01860; pattern in `pages/api/admin/viewers.js:16-17,35,57` |
| 3 | No direct bunny CDN file URLs (`*.b-cdn.net/.../playlist.m3u8`, `play_720p.mp4`) anywhere — playback only via signed, time-limited embed tokens; thumbnails only via token-signed CDN URLs | Core security property: videos are never public. A direct file URL bypasses token auth permanently | `lib/bunny.js:1-4` (stated invariant), `signEmbedUrl` at `lib/bunny.js:147`; README "Security notes"; see `architecture-contract` |
| 4 | Never commit a lockfile (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`) | Deliberate latest-versions policy: Vercel and CI install fresh every time. A stray lockfile out of sync with `package.json` is a documented deploy-failure mode | `.gitignore:1-6`; README "Common issues" ("`npm install` fails on deploy"); ci.yml:22-23 comment |
| 5 | New Redis keys ONLY via `k(...)` from `lib/redis.js` — never hand-build a key string | Every key is namespaced `fablevideo:`. Commit c37919e renamed the prefix (pvp:→fablevideo:) in ONE place because all keys go through `k()`; old `pvp:*` keys were NOT migrated — a hand-built key would have silently orphaned data | `lib/redis.js:5-9`; commit c37919e |
| 6 | Any new bunny.net mutation (create/update/delete video) calls `invalidateVideoListCache()` after the API call | The 4-second promise cache (added 68ee934 for homepage speed) would otherwise serve stale lists after an admin mutation | `lib/bunny.js:50-52` and call sites at lines 97, 106, 112 |
| 7 | Secrets stay server-side only. `NEXT_PUBLIC_` prefix embeds a var into the browser bundle — NO secret may ever carry it | Anything `NEXT_PUBLIC_*` is world-readable in the shipped JS. Today only `NEXT_PUBLIC_SITE_NAME` and `NEXT_PUBLIC_SENTRY_DSN` carry it, both non-secret by design | README env tables; `grep -rn NEXT_PUBLIC_ pages/ components/ lib/` |
| 8 | Share flows NEVER reveal the intended recipient. A logged-in user opening someone else's link sees a generic "made for someone else" message | Leaking the recipient email to an arbitrary logged-in user is an information disclosure | `pages/watch/[shareId].js:34-37` ("Never reveal the intended recipient"); README "Security notes" |
| 9 | ESLint stays `^9.x` — do NOT bump to 10 | Incident f2d3a30: ESLint 10 crashes eslint-config-next with `scopeManager.addGlobals is not a function`. This is a DATED exception (2026-07) to the owner's latest-versions doctrine; the re-check condition (eslint-config-next supporting ESLint 10) lives in `dependency-currency` | commit f2d3a30; `package.json` devDependencies (`"eslint": "^9.39.0"`) |
| 10 | Rate-limit expensive or abusable endpoints with `allowRequest(name, id, tokens, window)` following the existing pattern | Uploads, share creation, and the video list all hit external paid APIs or send email; unlimited calls = cost/abuse. The limiter fails OPEN (infra hiccup never locks users out) — do not change that semantic | `pages/api/admin/share.js:20` (30/h), `pages/api/admin/upload.js:15` (30/h), `pages/api/videos.js:18` (60/m); `lib/ratelimit.js:1-2` |
| 11 | Every admin mutation calls `logAction(admin, "noun.verb", detail)` after it succeeds | The Activity tab is the audit trail for a multi-admin portal. Logging is best-effort by design (never breaks the action) — but omitting the call breaks the trail | `lib/audit.js:1-2`; call sites in every mutating `pages/api/admin/*` route (e.g. `viewers.js:39,61`, `share.js:80`) |
| 12 | Failure semantics are asymmetric on purpose: viewer approval fails CLOSED, rate limiting fails OPEN — never flip either | Approval failing open leaks video data on an infra error; rate limiting failing closed locks out all real users on an infra error | `lib/guard.js:29-32`; `lib/ratelimit.js:1-2,27-29`; see `architecture-contract` |

## 4. Self-review before opening a PR

Walk this checklist against your diff. Every "yes" required.

- [ ] Change classified (section 1) and every required gate run and passing (section 2)?
- [ ] New/changed `/api/admin/*` route starts with the `requireAdmin` guard? (rule 1)
- [ ] Every new `catch` logs `console.error("label:", err)` before its 5xx? (rule 2)
- [ ] No direct CDN file URL introduced anywhere, including tests and comments used as examples? (rule 3)
- [ ] `git status` shows no lockfile staged? (rule 4)
- [ ] New Redis keys built with `k()`? (rule 5)
- [ ] New bunny mutation invalidates the video list cache? (rule 6)
- [ ] No secret in a `NEXT_PUBLIC_*` var, no secret in client-side code or props? (rule 7)
- [ ] Share/auth error paths reveal nothing about the intended recipient or approved-viewer list? (rule 8)
- [ ] Dependency versions untouched, or bumped per `dependency-currency` (ESLint still ^9)? (rule 9)
- [ ] New expensive/abusable endpoint rate-limited? (rule 10)
- [ ] New admin mutation calls `logAction`? (rule 11)
- [ ] Fail-open/fail-closed semantics unchanged? (rule 12)
- [ ] Tests added for new pure-logic code in `lib/`, and the counts in Gate 2 of this file updated if totals changed?
- [ ] README / CHANGELOG updated if behavior, env vars, or setup steps changed?

### Commit message style (observed in all 12 commits — match it)

- **Subject:** imperative mood, no trailing period, describes the change:
  "Resolve Redis env vars by suffix, not exact name", "Pin ESLint to 9.x for
  eslint-config-next compatibility".
- **Body:** explains WHY — the observed symptom, the root cause, and what was verified.
  See `git show 84dfbe3` or `git show 1e01860` for the house style: symptom first, then
  cause, then the fix and how it was verified.
- PR titles follow the same convention. Verify with `git log --format='%h %s%n%b'`.

## 5. When a gate fails

| Failure | Route to |
|---|---|
| `npm run lint` errors | Fix mechanically. If you believe the rule is wrong, follow the eef72fb pattern (disable WITH a rationale comment in `eslint.config.mjs`) — and only with clear justification |
| `npm test` failures | `validation-and-qa` (test design, what the 24 tests cover, how to extend) |
| `npm run build` fails on missing env | Re-run with the Gate 3 one-liner; if still failing, `environment-and-config` |
| `npm run build` fails on code error | `debugging-playbook` |
| `npm install` / peer-dependency errors (local or CI) | `dependency-currency` — likely fresh-resolution drift from the no-lockfile policy |
| CI red but local green | Suspect fresh-install drift (no lockfile) or Node version skew (CI = Node 22): `dependency-currency` |
| Runtime broken after deploy | `debugging-playbook`, then `run-and-operate` for rollback/redeploy |

## Provenance and maintenance

Written 2026-07-10 against commit 7968919 (v1.6.0, 12 commits). Facts below are volatile —
re-verify before relying on them; update this file when a check's expected output changes.

| Volatile claim | Re-verify with |
|---|---|
| Lint passes clean, banner-only output | `npm run lint; echo $?` (expect exit 0) |
| Test baseline is 4 files / 24 tests | `npm test 2>&1 \| grep -E "Test Files\|Tests"` |
| Build env block matches CI | `sed -n '33,46p' .github/workflows/ci.yml` |
| ESLint still pinned to ^9.x | `grep '"eslint"' package.json` |
| All admin routes guarded | `grep -L requireAdmin pages/api/admin/*.js` (expect no output) |
| No lockfile tracked | `git ls-files \| grep -iE 'package-lock\|yarn.lock\|pnpm-lock'` (expect no output) |
| Bunny mutations invalidate cache | `grep -n invalidateVideoListCache lib/bunny.js` (expect def + 3 call sites) |
| All admin mutations audit-logged | `grep -c logAction pages/api/admin/*.js` |
| Rate-limited endpoints and their budgets | `grep -rn allowRequest pages/api/` |
| Cited commit hashes still exist | `git log --oneline` |
| CI still runs lint→test→build on Node 22, `permissions: contents: read` | `cat .github/workflows/ci.yml` |
| Env-var redeploy requirement still documented | `grep -n "redeploy" README.md` |
