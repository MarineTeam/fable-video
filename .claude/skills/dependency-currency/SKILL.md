---
name: dependency-currency
description: The owner's "always latest versions" doctrine made operational and safe — how package.json's caret ranges + no committed lockfile mean every install (local, CI, Vercel) resolves independently. Load when bumping/adding/removing a dependency, when a deploy fails on install or with a peer-dependency error, when npm outdated shows a major behind, when a Dependabot/CodeQL alert needs a version bump, when CI is red but local is green with no code change, or when anyone suggests committing a lockfile.
---

# Dependency currency — Marine Video Portal

The owner's stated rule for this repo: **"use latest versions of software."** That is not
a vibe — it is implemented as a specific, load-bearing mechanism (section 1). This skill
tells you how to work with that mechanism safely: how to check currency, how to do a major
bump without breaking the deploy, the one dependency that is deliberately NOT on latest and
why, a risk table for every dependency in `package.json`, and how to diagnose a deploy that
broke with zero code changes.

## When NOT to use this skill

| You are trying to... | Use instead |
|---|---|
| Know which gates to run and how a PR is structured | `change-control` |
| Understand why the architecture is shaped the way it is (Pages Router commitment, etc.) | `architecture-contract` |
| Respond to a CodeQL/Dependabot alert that names a specific CVE | `security-response` (this skill covers the *mechanics* of the bump it will ask you to make) |
| Debug a runtime failure that isn't install/build related | `debugging-playbook` |
| Understand a past incident in detail beyond what's cited here | `failure-archaeology` |
| Deploy, redeploy, or roll back the running app | `run-and-operate` |
| Decide what to manually smoke-test after a bump | `validation-and-qa` |
| Look up bunny.net/Auth0/Upstash/Resend domain specifics unrelated to versioning | `domain-reference` |
| Add/change environment variables | `environment-and-config` |

Use **this** skill specifically for the version-currency mechanism: checking it, bumping a
major safely, the ESLint exception, and diagnosing drift.

## 1. The model — read this before touching `package.json`

Every dependency in `package.json` is a **caret range** (`^4.24.0`, `^19.2.7`, ...) and
`.gitignore` blocks every lockfile format, with this comment (verified verbatim,
`.gitignore` lines 1–6):

```
# dependencies — installed by Vercel/CI at deploy time; no lockfile is committed
# (a stray lockfile out of sync with package.json is a common deploy failure)
node_modules/
package-lock.json
yarn.lock
pnpm-lock.yaml
```

Consequence: **`npm install` — not `npm ci`** — runs at every install site (your shell,
CI's fresh checkout, Vercel's build step), and each one resolves the newest version
satisfying every caret range **at that moment**. There is no lockfile to pin the resolution,
so three installs run an hour apart can legitimately produce three different
`node_modules` trees. `npm ci` is not just unused here, it is **impossible** — it requires
`package-lock.json` to exist and this repo forbids one.

| | Consequence |
|---|---|
| (+) | Minor/patch security fixes arrive automatically, with no PR, the moment they publish — you get them for free on every deploy. |
| (+) | The tree never silently rots behind old minors; "latest within range" is the permanent default state. |
| (−) | A bad upstream minor/patch release can break a Vercel deploy with **zero commits to this repo**. The fix is a version bump (this skill), not a code fix. |
| (−) | **CI-green does not mean deploy-safe.** CI's `npm install` and Vercel's `npm install` happen at different times against the same `package.json` — they can resolve different trees. A PR can pass CI and still fail (or succeed differently) when Vercel builds `main` after merge. |
| (−) | `npm ci` (reproducible install from a lockfile) is categorically unavailable. Reproducibility comes only from pinning exact versions in `package.json` when needed (section 6). |

If anyone — human or agent — proposes adding a lockfile "for stability," that is a direct
reversal of the owner's doctrine. Don't do it silently; if you believe it's warranted, raise
it explicitly rather than adding one as a side effect of another change.

## 2. Routine currency check

Run this periodically and any time you're about to touch `package.json` for an unrelated
reason (touch it once, check everything while you're in there).

```bash
npm outdated
```

Real output, captured 2026-07-13 in this repo:

```
Package             Current  Wanted  Latest  Location                         Depended by
@upstash/ratelimit   v2.0.8   2.0.8   2.0.8  node_modules/@upstash/ratelimit  fable-video
eslint               9.39.4  9.39.5  10.7.0  node_modules/eslint              fable-video
```

(Exit code 1 — `npm outdated` exits non-zero whenever it has anything to report, even
non-major updates. That is not a failure signal by itself; read the columns.)

Column meanings:

| Column | Meaning | Action |
|---|---|---|
| `Current` | What's actually in `node_modules` right now | — |
| `Wanted` | The newest version matching the `package.json` range | Arrives **automatically** on the next `npm install` — no edit needed. `eslint` shows `9.39.5` wanted vs `9.39.4` current: a normal patch, will self-resolve. |
| `Latest` | The newest version published, ignoring the range | If different from `Wanted`, it's a **major** outside the current range and needs a deliberate section-3 bump. `eslint` shows `10.7.0` — this is the pinned exception, see section 4, do NOT bump it. |

The `@upstash/ratelimit` row (`v2.0.8` current/wanted/latest all equal) is a cosmetic quirk:
the installed metadata carries a `v` prefix that differs textually from the bare `2.0.8` in
`package.json`, so npm flags it despite there being no real update available. Not actionable.

Packages **not listed** by `npm outdated` (next, react, react-dom, @auth0/nextjs-auth0,
@sentry/nextjs, @upstash/redis, player.js, tus-js-client, eslint-config-next, vitest) are
already at `Latest` as of 2026-07-13 — no action needed on them right now.

Cross-check what's actually installed:

```bash
npm ls --depth=0
```

Real output, 2026-07-13:

```
marine-video-portal@1.6.0 /home/user/fable-video
+-- @auth0/nextjs-auth0@4.25.0
+-- @sentry/nextjs@10.65.0
+-- @upstash/ratelimit@v2.0.8
+-- @upstash/redis@1.38.0
+-- eslint-config-next@16.2.10
+-- eslint@9.39.4
+-- next@16.2.10
+-- player.js@0.1.0
+-- react-dom@19.2.7
+-- react@19.2.7
+-- tus-js-client@4.3.1
`-- vitest@4.1.10
```

(Ignore any `extraneous` lines for `@emnapi/*`/`@napi-rs/*`/`@tybys/*` — those are
transitive native-binding packages some optional dependency pulled in; not a
`package.json` concern.)

**Cadence:** run `npm outdated` monthly, and immediately after any security alert lands
(`security-response` will route you here for the bump mechanics). There's no automation for
this today — no `dependabot.yml` exists in the repo — so it is a manual habit, not a bot.

## 3. Major-bump runbook

Follow these steps in order. Do not skip the changelog read — that is precisely the step
that would have caught the ESLint 10 incident (section 4) before it happened.

1. **Read the release notes / migration guide FIRST**, for the specific version you're
   jumping to, not just the latest tag. Per-dependency links (verified against npm registry
   `repository` metadata 2026-07-13; GitHub org/repo, not necessarily every version's
   dedicated migration doc):
   - `next` / `eslint-config-next` (same monorepo, versions track together) —
     `https://github.com/vercel/next.js/releases`
   - `@auth0/nextjs-auth0` — `https://github.com/auth0/nextjs-auth0/releases` (v3→v4 had a
     dedicated `V4_MIGRATION_GUIDE.md` in-repo; expect the same pattern for v4→v5)
   - `react` / `react-dom` — `https://github.com/facebook/react/releases`
   - `@upstash/redis` — `https://github.com/upstash/redis-js/releases`
   - `@upstash/ratelimit` — `https://github.com/upstash/ratelimit` (repo name inferred from
     the package name; npm registry metadata for this package carries no `repository` field
     as of 2026-07-13 — verify the URL before trusting it)
   - `@sentry/nextjs` — `https://github.com/getsentry/sentry-javascript/releases`
   - `tus-js-client` — `https://github.com/tus/tus-js-client/releases`
   - `player.js` — `https://github.com/embedly/player.js` (essentially unmaintained
     upstream; see section 5)
   - `eslint` — `https://github.com/eslint/eslint/releases` (see section 4 before touching
     this one)
2. **Edit the range in `package.json`** for that one package. Bump only what you're
   deliberately upgrading — don't opportunistically bump siblings in the same edit unless
   they're a paired dependency (section 5 lists the pairs).
3. **Run `npm install`** (fresh resolution against the new range) and read what it prints.
   Watch for peer-dependency warnings even on success.
4. **Run all gates**, per `change-control` section 2: `npm run lint`, `npm test`,
   `npm run build`. The build needs the CI dummy env block — see `change-control`'s Gate 3
   for the exact one-liner (don't duplicate it here; it's the authoritative copy and drifts
   if maintained in two places).
5. **Manual smoke test** the surface the bumped package touches — follow
   `validation-and-qa` for what "smoke" means for that area (e.g., an upload-path bump
   needs an actual TUS upload attempt, not just green gates).
6. **Open the PR** per `change-control`'s branch → PR → CI → merge flow. Call out in the PR
   body which package/version and link the changelog you read in step 1.

**If `npm install` fails with a peer-dependency conflict:** read the conflict output
carefully — it names the package, the required range, and what's actually resolved. Do
**not** reach for `--legacy-peer-deps` or `--force` as a fix. Those flags suppress the
error without resolving the underlying incompatibility, and given this repo has no
lockfile, an install that only "works" with `--legacy-peer-deps` today can resolve
differently and break outright on the next fresh install (CI, Vercel, or a future
contributor's machine) with no flag to save it. Treat the conflict as **diagnostic only**:
it's telling you the major bump needs a paired bump (section 5) or that the target version
genuinely isn't ready to adopt yet. Fix the real incompatibility, or stop the bump and
document why in the PR.

## 4. The pinned exception — ESLint stays on 9.x

`package.json` devDependencies pin `"eslint": "^9.39.0"` — a caret range capped below the
current major, which is a deliberate exception to the owner's latest-versions doctrine.

**The incident** (commit `f2d3a30`, "Pin ESLint to 9.x for eslint-config-next
compatibility"): ESLint had been left on `^10.6.0`, and lint started crashing outright, not
just warning:

```
TypeError: scopeManager.addGlobals is not a function
```

The commit message's stated root cause: eslint-config-next 16's flat config, via its
typescript-eslint parser stack, only worked with the ESLint 9.x line at the time — ESLint
10 changed an internal `scopeManager` API that this stack depended on. `eslint-config-next`'s
own declared peer range (`>=9.0.0`, see below) does **not** encode this — it's a runtime
crash, not something npm's peer-resolver would catch. The fix was to cap `eslint` back to
`^9.39.0`, not to patch config.

**Re-verified live, 2026-07-13**, that this is still broken today, not just at the time of
the incident. In an isolated scratch install (`eslint@latest` = 10.7.0,
`eslint-config-next@latest` = 16.2.10 — both current latest as of this date) with the
repo's actual `eslint.config.mjs` pattern (`eslint-config-next/core-web-vitals` spread into
a flat config array) run against a trivial file:

```
Oops! Something went wrong! :(

ESLint: 10.7.0

TypeError: scopeManager.addGlobals is not a function
    at addDeclaredGlobals (.../eslint/lib/languages/js/source-code/source-code.js:221:15)
    ...
```

Identical failure, identical error string. **The rule stands: do not move `eslint` to
10.x** until this is confirmed fixed upstream.

**Re-check condition** — run this before ever attempting the bump again:

```bash
npm view eslint-config-next@latest peerDependencies
```

Real output, 2026-07-13: `{ eslint: '>=9.0.0', typescript: '>=3.3.1' }`. Note this range
already technically allows ESLint 10 and did at the time of the incident too — the peer
range is **necessary but not sufficient** evidence; it will not change to prove the fix.
Do not treat a peer-range change alone as a green light. The only reliable test is a live
smoke, same as the one above:

```bash
mkdir /tmp/eslint10-check && cd /tmp/eslint10-check
npm init -y >/dev/null
npm install eslint@latest eslint-config-next@latest next@latest react@latest react-dom@latest --no-save
printf 'import nextCoreWebVitals from "eslint-config-next/core-web-vitals";\nexport default [...nextCoreWebVitals];\n' > eslint.config.mjs
printf 'export default function Foo(){ return null; }\n' > test.js
./node_modules/.bin/eslint test.js; echo "exit:$?"
```

If this exits 0 (or fails only with genuine lint findings on `test.js`, not a `TypeError`),
eslint-config-next has caught up — only then edit `package.json`'s `eslint` range and follow
the full major-bump runbook (section 3), including the PR calling out that the historical
exception is being lifted and citing this re-check's output.

## 5. Risk watchlist — per dependency

Every entry in `package.json`, read 2026-07-13, with what a bump actually risks:

| Package | Current | Risk on bump |
|---|---|---|
| `next` | `^16.2.10` | Framework majors here are **migrations, not bumps** — this repo has a committed Pages Router architecture (see `architecture-contract`); a Next major can change routing/data-fetching conventions system-wide. Never treat a Next major as a routine caret bump — always full migration-guide read plus a dedicated PR. |
| `@auth0/nextjs-auth0` | `^4.24.0` | **Documented precedent for breaking majors**: v3→v4 renamed env vars (`AUTH0_BASE_URL`→`APP_BASE_URL`, `AUTH0_ISSUER_BASE_URL`→`AUTH0_DOMAIN`) and moved every auth route from `/api/auth/*` to `/auth/*` (README lines 120, 150, 220; `proxy.js`). A future v5 should be assumed to carry an equally disruptive rename/route-move until its migration guide says otherwise — budget an `environment-and-config` pass (Auth0 dashboard callback URLs) alongside any major bump here. |
| `react` + `react-dom` | `^19.2.7` / `^19.2.7` | **Paired — always bump together, same version.** A version-skewed React/ReactDOM pair fails in ways that are hard to diagnose (opaque hook/rendering errors, not a clean crash). |
| `@upstash/redis` + `@upstash/ratelimit` | `^1.38.0` / `^2.0.8` | Same vendor, used together (`lib/redis.js`, `lib/ratelimit.js`) but versioned independently upstream — check both changelogs together when bumping either, since a Redis client major can change the client shape `ratelimit` expects. |
| `@sentry/nextjs` | `^10.63.0` | Build-wrapping package — it patches the Next.js build (webpack/turbopack config) and can touch `next.config.js` semantics on a major. Bump requires the full build gate, not just lint/test, and a check that Sentry still initializes (inert-until-DSN-set today, per README, so a broken init may not surface until a DSN is configured). |
| `tus-js-client` | `^4.3.1` | Drives the admin resumable-upload path. A major here needs an actual manual upload smoke test (drag-drop, progress, cancel/retry) per `validation-and-qa` — this path has no automated test coverage (only `lib/__tests__/` pure-logic is tested). |
| `player.js` | `^0.1.0` | Essentially frozen upstream (0.x, infrequent releases) — low currency risk simply because there's rarely anything to bump. If it does break, `components/ResumablePlayer.js` is written to degrade gracefully: resume/progress tracking silently no-ops and plain embed playback continues (see the file's own comments and its `try`/`catch` around the `player.js` dynamic import). A break here is a UX papercut, not an outage. |
| `eslint` + `eslint-config-next` | `^9.39.0` / `^16.2.10` | The pinned pair — see section 4 in full. `eslint-config-next` tracks the `next` version number and is expected to move in lockstep with `next` bumps; `eslint` itself stays capped at 9.x independent of that. |
| `vitest` (dev) | `^4.1.9` | Test runner — a major bump changes Gate 2 in `change-control`. Re-verify the "4 files / 24 tests" baseline still reports correctly after any bump; update `change-control`'s cited counts if the format of that summary line changes. |

## 6. Drift diagnosis — deploy broke, no code changed

This is the failure mode the no-lockfile model makes possible: **fresh-resolution drift.**
Something upstream published a new minor/patch inside an existing caret range, and it
broke something, with zero commits to this repo between the last good deploy and the bad
one.

1. **Suspect this first** whenever a Vercel deploy fails (or behaves differently) and
   `git log` shows no relevant commit since the last good deploy. Also suspect it when CI
   was green on a PR but the same code fails differently after merge (CI's install and
   Vercel's install happened at different times — see section 1).
2. **Compare resolved versions.** Pull the package versions actually resolved in the Vercel
   build log (it prints what it installed) against your local tree:
   ```bash
   npm ls --depth=0
   ```
   Look for anything whose installed version is newer than what you last verified working.
3. **Reproduce locally** with a fresh resolution, matching what CI/Vercel just did:
   ```bash
   rm -rf node_modules && npm install
   ```
   Then re-run the gates (`change-control` section 2). If it fails the same way locally,
   you've confirmed drift, not an environment-specific Vercel issue (for genuinely
   Vercel-specific behavior — env vars, build settings, regions — hand off to
   `run-and-operate` instead).
4. **Once confirmed**, pin the culprit to an **exact** version (drop the caret) in
   `package.json` as a temporary, dated, documented exception:
   ```json
   "some-package": "10.4.2"
   ```
   ```
   // TEMP PIN 2026-07-13: some-package@10.5.0 broke <symptom>; see
   // https://github.com/org/some-package/issues/1234. Remove this pin once
   // that issue is closed and a fixed release is out — re-test with
   // `npm view some-package versions --json` for anything newer than 10.5.0.
   ```
   Put the comment directly above the pinned line (JSON has no native comments, but a `//`
   line is harmless here since nothing parses this file as strict JSON before npm reads it
   — confirm this convention doesn't already exist elsewhere in `package.json` before
   relying on it, and prefer a note in the PR description if you want to be strictly safe).
   State the removal condition explicitly — "when upstream ships a fix," not "eventually."
5. **Route onward:** deploy mechanics (rollback, redeploy, checking the Vercel dashboard)
   belong to `run-and-operate`. If the alert that surfaced this came from Dependabot/CodeQL
   rather than a broken deploy, that's `security-response`'s intake, not this runbook's.

## Provenance and maintenance

Written 2026-07-13 (three days after the orchestrator's 2026-07-10 baseline; versions were
re-verified live, not copied, since currency data goes stale fast by design). Verified
against commit history up to `f2d3a30` and the `package.json` in the working tree at time
of writing. Everything below is volatile — re-verify before trusting it.

| Volatile claim | Re-verify with |
|---|---|
| `.gitignore`'s lockfile-ban comment, verbatim | `sed -n '1,6p' .gitignore` |
| Current outdated/current versions | `npm outdated` and `npm ls --depth=0` |
| ESLint 10 still crashes eslint-config-next | Run the isolated smoke test in section 4 — do not skip it in favor of just reading `peerDependencies` |
| `eslint-config-next@latest` peer range | `npm view eslint-config-next@latest peerDependencies` |
| ESLint incident commit still reachable | `git show f2d3a30 --stat` |
| `@auth0/nextjs-auth0` v4 env-var/route rename still documented | `grep -n "AUTH0_BASE_URL\|APP_BASE_URL" README.md` |
| `player.js` graceful-degradation behavior unchanged | `Read components/ResumablePlayer.js`, check the `try`/`catch` around the dynamic `import("player.js")` |
| No `dependabot.yml` exists (manual cadence still required) | `test -f .github/dependabot.yml && echo present || echo absent` |
| Gate commands and expected output (don't duplicate here — read live) | `change-control` sections 2 and 5 |

### Unresolved / not independently confirmed

- `@upstash/ratelimit`'s upstream repository URL (`github.com/upstash/ratelimit`) is
  inferred from the package name — the npm registry's `repository`/`homepage` metadata for
  this package was empty at time of writing. Verify before citing it as authoritative.
- `@auth0/nextjs-auth0`'s v3→v4 migration guide filename (`V4_MIGRATION_GUIDE.md`) is cited
  from general knowledge of that project's convention, not fetched fresh for this file —
  confirm it still exists at that path before pointing someone at it in a PR.
