---
name: run-and-operate
description: Running, building, deploying, releasing, and operating the Marine Video Portal — npm run dev/build/start, the Vercel auto-deploy model, GitHub Actions CI as a status check, where logs/errors land (terminal, Vercel Deployments/Logs, browser console, GitHub Actions, Sentry), env-var redeploys, the release runbook (CHANGELOG → git tag → GitHub Release), Vercel instant rollback, and Redis-as-shared-production-data. Load when starting the dev server, running a production build locally, deploying, cutting a release, reading production logs, debugging "it works locally but not on Vercel", or rolling back a bad deploy.
---

# Run and operate — Marine Video Portal

This repo (v1.6.0, released 2026-07-07; today 2026-07-10) deploys to Vercel from the `main`
branch of `github.com/MarineTeam/fable-video`. This skill is the operator's manual: how to
run it locally, how a change becomes a live deploy, where every kind of output lands, and
how to release and roll back. It does not cover *whether* a change is safe to make — that's
`change-control`.

## When NOT to use this skill

| You are trying to... | Use instead |
|---|---|
| Decide if a change needs a PR, which gates apply, or the non-negotiable rules | `change-control` |
| Understand *why* the auth/caching/playback architecture is shaped this way | `architecture-contract` |
| Add/change an environment variable, or find the full env-var reference | `environment-and-config` |
| Fix `npm run lint`/`npm test` failures or decide what to test | `validation-and-qa` |
| Go from a runtime symptom (502, login loop, blank page) to a root cause | `debugging-playbook` |
| Inspect Redis keys, tail logs interactively, or use other local tooling | `diagnostics-and-tooling` |
| Respond to a CodeQL/Dependabot alert or a suspected secret leak | `security-response` |
| Bump a dependency or fix an install/peer-dependency failure | `dependency-currency` |
| Investigate a past incident or why a specific commit exists | `failure-archaeology` |
| Write the CHANGELOG entry text or README prose | `docs-and-writing` |
| Look up bunny.net/Auth0/Upstash/Resend field-level specifics | `domain-reference` |
| Plan a whole feature end to end (this skill covers only the ops leg) | `feature-shipping-campaign` |

Use **this** skill once code is ready to run, ship, release, or debug in production.

---

## 1. Run locally

### `npm run dev`

```bash
npm run dev
```

Verified 2026-07-13 (Node v22.22.2, npm 10.9.7, no env vars set, no `.env.local` present —
this repo ships no `.env.example` either). Actual observed startup:

```
> marine-video-portal@1.6.0 dev
> next dev

▲ Next.js 16.2.10 (Turbopack)
- Local:         http://localhost:3000
- Network:       http://192.0.2.2:3000
✓ Ready in 372ms
[@sentry/nextjs] DEPRECATION WARNING: disableLogger is deprecated and will be removed in a
future version. Use webpack.treeshake.removeDebugLogging instead. (Not supported with Turbopack.)
```

The Sentry deprecation warning is cosmetic and appears even with no DSN configured — ignore it.

**Every route 500s with no env vars, including `/`.** This is not a bug to chase — it's
`proxy.js`'s matcher (`/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)`),
which runs Auth0's session middleware on virtually every request, including the homepage.
Observed response to `curl http://localhost:3000/` with no env: HTTP 500, body contains

```
⨯ Error [DomainResolutionError]: Domain resolver threw an error.
    at proxy (proxy.js:7:16)
  ...
  [cause]: Error [InvalidConfigurationError]: Missing: domain: Set AUTH0_DOMAIN env var...
```

along with missing-`AUTH0_CLIENT_ID`/`AUTH0_SECRET`/`AUTH0_CLIENT_SECRET` warnings printed to
the dev-server terminal. **This is expected** without real credentials — it is not a build
error. To get past it you need working Auth0/bunny/Redis credentials in `.env.local` (see
`environment-and-config` for the full variable template and what each one does). Static
assets under `_next/static`, `_next/image`, `favicon.ico`, `sitemap.xml`, `robots.txt` are
excluded from the matcher and load fine even with no env.

`.env.local` is gitignored (`.gitignore`: `.env` / `.env.*`, with `!.env.example` — but no
`.env.example` currently exists in this repo, so there is no template file to copy; build
the file from the README's "Environment variables" tables or `environment-and-config`).

Always kill the dev server when you're done (`Ctrl-C`, or `kill` the PID) — it holds
port 3000 and locks `.next/`.

### Production build + start locally

`npm run build` needs the same env vars as CI, or it fails during static analysis/page
data collection. Reproduce CI's build locally with this exact one-liner (values copied
from `.github/workflows/ci.yml`, dummy/non-functional):

```bash
AUTH0_SECRET=6f0f2c9a4d1e8b37c5a2f4d6e8091b3d5f7a9c1e3b5d7f90a2c4e6081b3d5f70 AUTH0_DOMAIN=example.us.auth0.com AUTH0_CLIENT_ID=ci-client-id AUTH0_CLIENT_SECRET=ci-client-secret APP_BASE_URL=http://localhost:3000 ADMIN_EMAILS=admin@example.com BUNNY_LIBRARY_ID=1 BUNNY_API_KEY=ci-dummy-key BUNNY_TOKEN_AUTH_KEY=ci-dummy-token KV_REST_API_URL=https://ci-dummy.upstash.io KV_REST_API_TOKEN=ci-dummy npm run build
```

Verified passing 2026-07-10 (per `change-control`): exit 0, output ends with a route table
(`Route (pages) ...`) listing `○ /404` (static) and `ƒ` (dynamic) routes for `/`, `/admin`,
every `/api/*`, `/watch/*`, plus `ƒ Proxy (Middleware)`.

**Do not run `npm run build` yourself if other agents/tasks may be working in this same
checkout** — `next build` writes to `.next/` and parallel builds collide. Cite the
2026-07-10 verified baseline above instead of re-running it, unless you have exclusive
access to the checkout.

After a successful build:

```bash
npm start
```

serves the built app from `.next/` on port 3000 (same port, same env-var requirement as
`dev` — pass the same dummy block, or real values, as an env prefix or via `.env.local`/
your shell). Unlike `next dev`, this is the production server (no Turbopack, no HMR) — it's
the closest local approximation to what Vercel runs.

---

## 2. Deploy model

```
feature branch → PR to main → CI runs lint→test→build → merge → Vercel builds & deploys main automatically
```

Precisely:

1. **Vercel auto-deploys every push to `main`.** This is standard Vercel behavior for a
   GitHub-connected project — verify the exact trigger config (production branch, ignored
   build step, etc.) in the Vercel dashboard; it is not readable from this repo checkout.
2. **Vercel runs its own `npm install`** at deploy time, independent of and possibly minutes
   after CI's install. Because there is no committed lockfile (by design — see
   `change-control` non-negotiable #4), Vercel's fresh resolve of `package.json`'s caret
   ranges can differ from what CI just resolved and tested. If something works in CI but
   breaks on Vercel (or vice versa), suspect version drift first — route to
   `dependency-currency`.
3. **GitHub Actions CI** (`.github/workflows/ci.yml`) runs on every push/PR to `main`:
   `npm install` → `npm run lint` → `npm test` → `npm run build` on Node 22, with the dummy
   env block shown above baked into the workflow file.
4. **CI is a status check, not necessarily a deploy gate.** Nothing in this repo forces a
   red CI run to block a merge or a Vercel deploy unless GitHub branch protection is
   configured to require the check. The README recommends enabling branch protection, but
   **whether it is currently enabled is not verifiable from this checkout** — check
   `github.com/MarineTeam/fable-video` → Settings → Branches, or ask the owner. State this
   honestly; do not assume CI is blocking.
5. **PR workflow** observed in all 12 commits of git history: work on a feature branch
   (never commit directly to `main`), open a PR to `main`, wait for CI to go green, merge.
   No manual deploy step exists for ordinary code changes — merging *is* the deploy trigger.

---

## 3. Where output lands

| Source | Where to look | Notes |
|---|---|---|
| Local `next dev` / `next start` | The terminal you ran it in | `console.error` calls in API routes print here directly |
| Vercel build logs | Vercel dashboard → project → **Deployments** → click a deployment | Shows the `npm install` + `next build` output for that deploy |
| Vercel runtime logs | Vercel dashboard → project → **Logs** (or a deployment's **Functions** tab) | Every `console.error("label:", err)` in an API route (change-control rule #2) lands here as a greppable string; see `debugging-playbook` for the symptom→label table |
| Client-side errors | Browser DevTools → **Console** and **Network** tabs | Only place to see fetch failures, React errors, and the actual HTTP status/body of a failed `/api/*` call from the page |
| CI results | GitHub → repo → **Actions** tab, or the checks list on a PR | Full lint/test/build output per run, per Node version (22) |
| Sentry | Sentry dashboard, **only if `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` is set** | Verified 2026-07-13 by reading `instrumentation.js`, `instrumentation-client.js`, `sentry.server.config.js`, `sentry.edge.config.js`: every one of them wraps `Sentry.init(...)` in `if (process.env.SENTRY_DSN)` / `if (process.env.NEXT_PUBLIC_SENTRY_DSN)`. With no DSN configured, Sentry is a true no-op — nothing is captured or sent anywhere. Do not expect Sentry data unless you've confirmed the DSN vars are set in Vercel |

For the meaning of specific error-log strings (e.g. `"Could not load viewers"`,
`"Could not load videos from bunny.net"`), don't reverse-engineer them here — go to
`debugging-playbook`, which maps observed symptoms to root causes.

---

## 4. Env-var changes require a redeploy

**No exceptions.** Changing, adding, or removing a Vercel environment variable does nothing
to already-running deployments — "changes only apply to new deployments" (README, "Environment
variables" section). After any env change:

Vercel dashboard → project → **Deployments** → find the deployment you want live → **⋯** menu
→ **Redeploy**.

(Label: standard Vercel behavior — verify the exact menu wording in the dashboard, it may
differ slightly by Vercel UI version.) This applies to *every* env var in the README's
tables — Auth0, bunny.net, Redis, Resend, Sentry — including flipping an optional one like
`SENTRY_DSN` on or off. See `environment-and-config` for what each variable does and how to
add a new one correctly.

---

## 5. Release runbook

Only one release exists so far (v1.6.0, 2026-07-07), so the numbering convention below is a
**candidate**, not a proven pattern — treat step 6 (version bump) as inferred from
`package.json` tracking the release, not as an observed repeat.

1. **Confirm `main` is green.** Check the latest commit on `main` in GitHub Actions —
   lint/test/build all passing. Do not start a release on a red `main`.
2. **Update `CHANGELOG.md`** with a new `## [x.y.z] - YYYY-MM-DD` section (see the existing
   `## [1.6.0] - 2026-07-07` entry for the house format: an intro paragraph, then `### Added`
   / `### Performance` etc. subsections). Use `docs-and-writing` for the template and prose
   conventions.
3. **Bump the version** in `package.json` (`"version": "1.6.0"` today) to match the tag you're
   about to cut. This is a config-env-class change per `change-control` — run all three
   gates (lint, test, build) before merging.
4. **Open a PR, get CI green, merge to `main`** — same flow as any other change (section 2
   above). Vercel deploys the merged `main` automatically; no separate "release deploy" step.
5. **Cut the GitHub Release**: repo → **Releases** → **"Draft a new release"** → create a new
   tag `vX.Y.Z` targeting `main` → paste in the matching `CHANGELOG.md` section as the
   release body → **Publish release**.
6. **Dated operational note (2026-07-07):** pushing a git tag from a remote Claude session
   hit a proxy policy block in that environment, so v1.6.0's tag and release were created
   directly through the GitHub web UI instead of `git tag && git push --tags`. This may not
   apply to your current environment — try the CLI path first if you have git push access
   and only fall back to the GitHub UI (step 5) if tag-pushing is blocked.

---

## 6. Rollback and incident basics

- **Instant rollback:** Vercel dashboard → project → **Deployments** → find the last-known-good
  deployment → **Promote to Production** / **Rollback** (exact label varies by Vercel UI
  version — standard Vercel behavior, verify in dashboard). This is the fastest way to undo a
  bad deploy; it does not touch git history or require a revert commit.
- **Env-var rollback also needs a redeploy.** Reverting a bad env-var change in the Vercel UI
  does not retroactively fix the currently-live deployment — you must redeploy (section 4)
  after reverting the value, same as any other env change.
- **Redis is shared production data, not a deploy artifact.** Every deployment (old or new,
  rolled back or not) reads and writes the *same* Upstash Redis database — viewer lists,
  share links, watch progress, settings, the audit log. **Rolling back a deployment does
  NOT roll back Redis data.** If a bad deploy wrote bad data (e.g. corrupted settings, wrong
  viewer list), rolling back the code will not undo that — you must fix the data directly.
  **Never flush or bulk-delete Redis keys** as a rollback shortcut; route data inspection and
  safe fixes to `diagnostics-and-tooling`.
- For diagnosing *why* something broke before deciding whether a rollback is even the right
  move, start at `debugging-playbook`.

---

## 7. Routine operations (operator's map, not a user manual)

All of these happen in `/admin` (gated to `ADMIN_EMAILS`; tab names verified against
`pages/admin.js` 2026-07-13: Videos, Viewers, Shares, Settings, Activity, Analytics).

| Task | Where |
|---|---|
| Add / remove an approved viewer | `/admin` → **Viewers** tab (single or bulk-paste add) |
| Share a video with someone (one-off link) | `/admin` → **Videos** tab → per-video **Share** action (optional one-click email if Resend is configured) |
| Revoke or resend a share link | `/admin` → **Shares** tab |
| Upload a new video | `/admin` → **Videos** tab → drag-and-drop upload (resumable, shows progress and encoding-status badges) |
| Change the homepage video count or color palette | `/admin` → **Settings** tab |
| Check what admins have been doing | `/admin` → **Activity** tab (audit log) |
| Check view counts / watch time | `/admin` → **Analytics** tab |

This table is a map to the right tab, not instructions for every field in it — the UI is
self-explanatory once you're in the right place.

---

## Provenance and maintenance

Written 2026-07-13 against commit `1be60d7` (v1.6.0, `main`). Local verification performed
directly during authoring: `npm run dev` started and was curled with no env vars (observed
the Turbopack banner, then a 500 with `DomainResolutionError` from `proxy.js` on `/`), and
the process was killed afterward. `npm run build` was **not** re-run (concurrency risk per
the change-control warning) — its baseline is cited from `change-control`, verified there
2026-07-10.

| Volatile claim | Re-verify with |
|---|---|
| `npm run dev` startup banner / port / Turbopack | `npm run dev` (kill it after) |
| Every route 500s with no env vars (proxy.js matcher) | `cat proxy.js`; `curl -i http://localhost:3000/` while `next dev` runs with no env |
| No `.env.example` committed | `ls .env.example` (expect "No such file") |
| Build dummy-env one-liner matches CI | `sed -n '33,46p' .github/workflows/ci.yml` |
| Build baseline (route table, exit 0) | See `change-control`'s Gate 3 section; re-run only with exclusive checkout access |
| Sentry configs are inert without a DSN | `grep -n "SENTRY_DSN" instrumentation-client.js sentry.server.config.js sentry.edge.config.js` |
| Admin tab names | `grep -n "Videos\|Viewers\|Shares\|Settings\|Activity\|Analytics" pages/admin.js` |
| Only one release exists (candidate release convention) | `git tag --list`; repo → Releases |
| package.json version | `grep '"version"' package.json` (currently `1.6.0`) |
| Branch-protection / CI-blocking status | GitHub repo → Settings → Branches (not verifiable from this checkout) |
| Vercel auto-deploy trigger / rollback UI wording | Vercel dashboard (not verifiable from this checkout) |
