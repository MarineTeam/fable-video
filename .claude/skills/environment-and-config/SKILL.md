---
name: environment-and-config
description: Every configuration axis of the Marine Video Portal — it is ALL environment variables, no flag system, no config files. Load when setting up the project locally, adding or changing an env var, configuring Vercel (Environment Variables / Storage tab), recreating a working environment from scratch, or debugging a config-shaped failure (missing/blank var, wrong scope, stale deploy, "Redis client was initialized without url or token", auth callback mismatch, thumbnails not showing, emails not sending). Triggers on .env.local, .env.example, process.env, environment variable, env var, Vercel settings, redeploy, AUTH0_*, BUNNY_*, KV_REST_API_*, UPSTASH_*, RESEND_API_KEY, SENTRY_DSN, NEXT_PUBLIC_*.
---

# Environment and config — Marine Video Portal

This app has **no config files and no feature-flag system**. Every behavioral switch —
which services are wired up, which features are enabled, what the app is named, whether
errors are captured — is an environment variable. This skill is the ground-truth inventory
of every one of them, how they resolve, what happens when they're missing, and how to
stand up a working environment from nothing.

## When NOT to use this skill

| You are trying to... | Use instead |
|---|---|
| Decide which gates apply to an env/config-file change, or what a config-touching PR requires | `change-control` |
| Debug a runtime failure whose cause isn't obviously a missing/wrong env var (500s with a code stack trace, login loops after config already looks right) | `debugging-playbook` |
| Understand *why* the suffix-resolution or trim-defensively patterns exist (the incidents) | `failure-archaeology` |
| Look up what a var's underlying service actually does (bunny.net library concepts, Auth0 tenant concepts, Upstash concepts) | `domain-reference` |
| Trigger a Vercel redeploy or roll one back once you already know the var is set correctly | `run-and-operate` |
| Decide what to test / write a test for env-dependent code | `validation-and-qa` |
| Update the README's env-var tables in prose | `docs-and-writing` |

Use **this** skill whenever the task is: "what var controls X", "add a new var", "why isn't
service X working locally/in prod", or "set up this repo from a fresh clone/fresh Vercel
project."

---

## 1. Complete environment variable inventory

Built by grepping the actual consumers (`grep -rn "process.env" --include="*.js" lib/ pages/
components/ next.config.js sentry*.js instrumentation*.js proxy.js`, 2026-07-10) and
cross-checked against `README.md`'s env tables (lines ~105–141). Every row below cites the
exact file/line. Auth0 v4's `Auth0Client()` constructor (`lib/auth0.js:6`) reads its four
vars **inside the SDK**, not via a visible `process.env.X` in this repo's code — that's
marked "SDK-internal" below and sourced from `lib/auth0.js`'s own comment plus README.

| Variable | Required? | Consumed by | Behavior when unset | Secret? | Notes |
|---|---|---|---|---|---|
| `AUTH0_SECRET` | **Required** | `Auth0Client()`, SDK-internal (`lib/auth0.js:6`) | Auth throws at construction; every page/route errors. CI's build step sets it — treat as build-required too. | **Yes** | `openssl rand -hex 32` |
| `AUTH0_DOMAIN` | **Required** | `Auth0Client()`, SDK-internal | Same as above | No (but keep private) | Tenant domain, **no** `https://` scheme, e.g. `your-tenant.us.auth0.com` |
| `AUTH0_CLIENT_ID` | **Required** | `Auth0Client()`, SDK-internal | Same as above | No (keep private) | From the Auth0 application settings |
| `AUTH0_CLIENT_SECRET` | **Required** | `Auth0Client()`, SDK-internal | Same as above | **Yes** | From the Auth0 application settings |
| `APP_BASE_URL` | **Required** | `Auth0Client()` SDK-internal (redirect URIs) **and** `lib/shares.js:88` `shareUrl()` | SDK: broken callback/redirect behavior. `shareUrl()`: falls back to `https://${req.headers.host}` when this is unset (`lib/shares.js:88-91`) — so share links can still form a URL, but production should always set it explicitly. | No | Exact site URL, **no trailing slash**, e.g. `https://your-app.vercel.app` |
| `ADMIN_EMAILS` | **Required** (for any admin access) | `lib/auth.js:11` `adminEmails()` | Empty string → `adminEmails()` returns `[]` → `isAdmin()` always `false` → **nobody** can reach `/admin` or bypass viewer approval. | No (sensitive — it's an allowlist) | Comma-separated; each entry trimmed + lowercased by `normalizeEmail()` (`lib/auth.js:4-8`) |
| `BUNNY_LIBRARY_ID` | **Required** (video features) | `lib/bunny.js:13` `libraryId()`, used in every `api()` call URL | Blank → bunny.net API calls hit a malformed URL path, fail (401/404-class errors) | No (keep private) | Numeric library ID, as a string |
| `BUNNY_API_KEY` | **Required** | `lib/bunny.js:14` `apiKey()`, sent as `AccessKey` header | Blank → every bunny.net API call returns 401 | **Yes** | Stream library API key |
| `BUNNY_TOKEN_AUTH_KEY` | **Required** (playback) | `lib/bunny.js:15` `tokenAuthKey()` — used by `signEmbedUrl()` (line 147) and as the fallback for `cdnTokenKey()` | Blank → `signEmbedUrl()` still produces a URL, but the signature hashes an empty key — playback tokens are wrong/guessable | **Yes** | bunny.net library's Embed View Token Authentication key (Security tab) |
| `BUNNY_CDN_HOSTNAME` | Optional | `lib/bunny.js:16` `cdnHostname()`, gates `thumbnailsEnabled()` (line 173-175) | Unset → `thumbnailsEnabled()` is `false` → homepage falls back to a plain title list, no thumbnails | No | Pull-zone host, e.g. `vz-xxxx-xxx.b-cdn.net`. This is the on/off switch for thumbnails. |
| `BUNNY_CDN_TOKEN_KEY` | Optional | `lib/bunny.js:17` `cdnTokenKey()` | Unset → falls back to `BUNNY_TOKEN_AUTH_KEY` (same line) — no functional loss unless the pull zone actually uses a different key | **Yes** (when set) | Only needed if the pull zone's URL Token Authentication key differs from `BUNNY_TOKEN_AUTH_KEY` |
| `KV_REST_API_URL` | **Required*** | `lib/redis.js:16-19` `envBySuffix()`, consumed at `lib/redis.js:26` | See suffix resolution (§2). If neither this, a `*_KV_REST_API_URL` suffix match, nor an Upstash alternate resolves, the `Redis` client is constructed with `url: undefined` → throws on first use (`"Redis client was initialized without url or token"`) | No | Auto-injected by Vercel's Storage tab when a Redis/Upstash DB is connected |
| `KV_REST_API_TOKEN` | **Required*** | same as above, `lib/redis.js:27` | same failure mode | **Yes** | Auto-injected alongside the URL |
| `UPSTASH_REDIS_REST_URL` | Alternate to `KV_REST_API_URL` | `lib/redis.js:26` fallback | Only matters if `KV_REST_API_URL` (exact or suffix) is absent | No | Used only when the `KV_REST_API_*` names don't resolve |
| `UPSTASH_REDIS_REST_TOKEN` | Alternate to `KV_REST_API_TOKEN` | `lib/redis.js:27` fallback | Same | **Yes** | Same |
| `RESEND_API_KEY` | Optional | `lib/email.js:8-11` `emailEnabled()` | Unset (with or without `EMAIL_FROM`) → `emailEnabled()` is `false` → share creation still works, admin copies the link manually (`lib/email.js:1-4` header comment) | **Yes** | Resend API key |
| `EMAIL_FROM` | Optional | `lib/email.js:11,15,35` | Same degraded behavior as above | No | Sender, e.g. `Marine Video Portal <videos@yourdomain.com>`; domain must be verified in Resend |
| `EMAIL_REPLY_TO` | Optional | `lib/email.js:36-37` | Unset → no `reply_to` field sent | No | — |
| `SITE_NAME` | Optional | `lib/email.js:18-20` `siteName()` | Unset → defaults to `"Marine Video Portal"` | No | Used inside outgoing emails only |
| `NEXT_PUBLIC_SITE_NAME` | Optional | `pages/_app.js:31`, `components/AppShell.js:4` | Unset → defaults to `"Marine Video Portal"` | No — **browser-exposed by design** | Portal name shown in header/title |
| `SENTRY_DSN` | Optional | `sentry.server.config.js:4-6`, `sentry.edge.config.js:4-6` | Unset → `Sentry.init()` is never called → no server/edge error capture, app runs normally | Not really secret (DSNs are commonly public), but don't advertise it unnecessarily | Runtime error capture, server side |
| `NEXT_PUBLIC_SENTRY_DSN` | Optional | `instrumentation-client.js:4-6` | Unset → no client-side error capture | No — browser-exposed by design, and DSNs aren't secret | Runtime error capture, client side |
| `SENTRY_ORG` | Optional | `next.config.js:11` | Unset → Sentry build plugin skips org-scoped calls; does not fail the build | No | Build-time source-map upload only |
| `SENTRY_PROJECT` | Optional | `next.config.js:12` | Same | No | Build-time only |
| `SENTRY_AUTH_TOKEN` | Optional | `next.config.js:13` | Same | **Yes** | Build-time only — never expose client-side, never `NEXT_PUBLIC_` |
| `CI` | Not user-set | `next.config.js:14` (`silent: !process.env.CI`) | Unset locally → Sentry webpack plugin logs verbosely during `next build`. GitHub Actions sets `CI` automatically → silent in CI. | No | Framework/platform-set, not something you put in `.env.local` |

\* "Required*" for Redis: required in the sense that admin panel + viewer approval need a
working client, but the app doesn't crash at import time the way Auth0 does — it fails at
first Redis call. See the degraded-mode matrix (§3).

### README ↔ code inventory mismatches found (2026-07-13)

- `CI` is real code (`next.config.js:14`) but **not documented anywhere in README** — it's
  low-stakes (platform-set, not a var anyone hand-configures) but worth knowing it exists
  if you're wondering why local `npm run build` is chattier than CI's.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are real fallback code paths
  (`lib/redis.js:26-27`) and are mentioned in README's "Common issues" prose (line 224,
  parenthetically) but **not listed as their own row in the env tables** (README only
  tables `KV_REST_API_URL` / `KV_REST_API_TOKEN`, lines 118). Documented properly in the
  inventory above and in `references/env.local.template`.
- `APP_BASE_URL`'s second consumer, `lib/shares.js:88` (`shareUrl()`'s host-header
  fallback), isn't called out in README — README only frames `APP_BASE_URL` as an Auth0
  variable. Not a bug, just an undocumented second use worth knowing when debugging share
  links that resolve to the wrong host.
- Nothing found in code that README documents but that doesn't exist in code (no stale
  README rows as of this pass).

Re-run the grep in the header of §1 before trusting this table on a future date — it is a
snapshot, not a live view.

---

## 2. Suffix resolution (Redis/Upstash vars)

`lib/redis.js:15-19`, quoted exactly:

```js
// Vercel prefixes storage-integration env vars with the store's name when a
// project has more than one connected (e.g. "fablevideo_KV_REST_API_URL"
// instead of plain "KV_REST_API_URL"), so match by suffix rather than an
// exact key.
function envBySuffix(name) {
  if (process.env[name]) return process.env[name];
  const key = Object.keys(process.env).find((k2) => k2.endsWith(`_${name}`));
  return key ? process.env[key] : undefined;
}
```

Called as `envBySuffix("KV_REST_API_URL") || envBySuffix("UPSTASH_REDIS_REST_URL")` and the
token equivalent (`lib/redis.js:26-27`). Resolution order, precisely:

1. **Exact match wins first**: if `process.env.KV_REST_API_URL` is set (non-empty), use it —
   full stop, no suffix scan happens.
2. **Else, suffix scan**: find the first key in `Object.keys(process.env)` that ends with
   `_KV_REST_API_URL` (e.g. `fablevideo_KV_REST_API_URL`) and use its value.
3. **Else, repeat both steps for `UPSTASH_REDIS_REST_URL`.**
4. Same two-step process independently for the token half.

Why this exists (incident f643a59): Vercel's Storage tab auto-injects env vars named after
the connected store. With exactly one Redis/Upstash store connected, the vars land as plain
`KV_REST_API_URL`/`KV_REST_API_TOKEN`. With **more than one** store connected to the same
project, Vercel prefixes them with the store's name to disambiguate — so the plain name
never appears, only the prefixed one.

**Honest caveat — ambiguity with two connected stores of the same kind:** if two Redis/
Upstash stores are both connected and *both* produce a key ending in `_KV_REST_API_URL`
(e.g. `store-one_KV_REST_API_URL` and `store-two_KV_REST_API_URL`), `Object.keys(process.env)`
returns whichever one V8's key-ordering puts first — this is **not guaranteed to be the
store you intend**, and `envBySuffix` has no way to disambiguate further. If you hit this:
go to Vercel → Settings → Environment Variables and set `KV_REST_API_URL` /
`KV_REST_API_TOKEN` explicitly (exact, unprefixed names) pointing at the store you actually
want. The exact-name check in step 1 always wins over any suffix scan, so this fixes the
ambiguity deterministically.

---

## 3. Degraded-mode matrix

What still works with a given group of vars missing. Useful when running locally with
partial config, or diagnosing "it half-works in prod."

| Missing | What breaks | What still works |
|---|---|---|
| Any of `AUTH0_SECRET` / `AUTH0_DOMAIN` / `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET` / `APP_BASE_URL` | Everything. No degraded mode — the Auth0 client fails at construction and every page needs a session. CI proves these are needed even to get a clean `next build`. | Nothing meaningful |
| `ADMIN_EMAILS` | `isAdmin()` always `false` (`lib/auth.js:17-20`) → `/admin` unreachable, no `requireAdmin` route passes, no one can approve new viewers or manage anything | Existing approved viewers (if any were seeded before this was unset) can still watch — but there is no way to add more, since only an admin session can |
| `BUNNY_LIBRARY_ID` / `BUNNY_API_KEY` / `BUNNY_TOKEN_AUTH_KEY` | Video listing, playback, upload — all bunny.net API calls fail | Auth, admin panel shell, approval/share plumbing (all Redis-backed, independent of bunny) |
| `BUNNY_CDN_HOSTNAME` | Thumbnails — `thumbnailsEnabled()` is `false` (`lib/bunny.js:173-175`) | Playback, everything else — homepage just shows a title list instead of a thumbnail grid |
| `BUNNY_CDN_TOKEN_KEY` | Nothing, if `BUNNY_TOKEN_AUTH_KEY` is set (automatic fallback, `lib/bunny.js:17`) | Everything |
| `KV_REST_API_URL`/`_TOKEN` (and no suffix match, no Upstash alternate) | Admin panel (Viewers/Shares/Activity/Settings/Analytics — all Redis-backed) throws on load. **Viewer approval fails closed**: `requireApproved()` catches the Redis error and treats it as "not approved" (`lib/guard.js:26-32`, comment: "Approval fails closed — no video data leaks on an infra error") | **Admins only** can still watch videos — `isAdmin()` is a pure `ADMIN_EMAILS` string check with no Redis dependency, checked *before* the approval path in `requireApproved()` (`lib/guard.js:25`). Non-admin approved viewers are locked out entirely. |
| `RESEND_API_KEY` and/or `EMAIL_FROM` | Automatic share-link emailing (`emailEnabled()` false, `lib/email.js:10-12`) | Share creation itself still works — admin sees the link and copies it manually (by design, per the file header comment) |
| `EMAIL_REPLY_TO` | Nothing — cosmetic (no reply-to header on sent emails) | Everything |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | Error capture (server/client respectively) — you fly blind on unhandled exceptions in production | Everything functional; just unmonitored |
| `SENTRY_ORG`/`SENTRY_PROJECT`/`SENTRY_AUTH_TOKEN` | Source-map upload at build time (stack traces in Sentry are minified/unreadable) | The build itself, and the running app — these are inert unless all three are set |
| `SITE_NAME` / `NEXT_PUBLIC_SITE_NAME` | Nothing — cosmetic defaults to `"Marine Video Portal"` | Everything |

**Practical local-dev reading of this table**: you can run `npm run dev` with only Auth0 +
`ADMIN_EMAILS` + Redis configured and log in as an admin to see most of the admin panel
work, even with bunny.net entirely unconfigured (video-specific calls will error, but
Viewers/Shares/Activity tabs render). To see actual video playback you need real bunny.net
credentials — there's no local video mock in this repo.

---

## 4. Local setup from scratch

```bash
# 1. Check Node version — must be >= 20.9.0 (package.json "engines")
node --version

# 2. Install dependencies (no lockfile is committed, by design — see change-control
#    non-negotiable #4). This is expected to create a gitignored package-lock.json
#    and node_modules/ — that's normal, not a mistake to "fix".
cd /home/user/fable-video
npm install

# 3. Create your local env file from this skill's template
cp .claude/skills/environment-and-config/references/env.local.template .env.local
# then edit .env.local and fill in real values (see §1 for what each does)

# 4. Run the dev server
npm run dev
# -> http://localhost:3000
```

### What you need for which level of "working"

| Goal | Minimum vars |
|---|---|
| `npm run lint` | None — pure static analysis |
| `npm test` | None — Vitest tests in `lib/__tests__/` set/unset their own env per test (see e.g. `lib/__tests__/email.test.js:6-11`) |
| `npm run build` (production build, no real services needed) | Exactly the CI dummy block — `AUTH0_SECRET`, `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `APP_BASE_URL`, `ADMIN_EMAILS`, `BUNNY_LIBRARY_ID`, `BUNNY_API_KEY`, `BUNNY_TOKEN_AUTH_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` — verbatim from `.github/workflows/ci.yml`. This set is documented as the **build-only minimal set**: it satisfies whatever runs at build/page-collection time, but every value is a dummy — none of it talks to a real service. Do not run this yourself against the live checkout if other agents/tasks may be building in parallel (`.next/` collisions) — see `change-control` Gate 3. Treat the 2026-07-10 verified-passing baseline in `change-control` as authoritative unless you have a reason to re-verify. |
| `npm run dev` with login working | A **real Auth0 free tenant**: create a Regular Web Application, set Allowed Callback URLs to `http://localhost:3000/auth/callback`, Allowed Logout URLs to `http://localhost:3000`, disable open sign-ups, add yourself under User Management. Real `AUTH0_SECRET`/`AUTH0_DOMAIN`/`AUTH0_CLIENT_ID`/`AUTH0_CLIENT_SECRET`/`APP_BASE_URL=http://localhost:3000`. |
| Admin panel usable end-to-end (viewers/shares/activity) | Above, plus a real Upstash Redis database (free tier) for `KV_REST_API_URL`/`KV_REST_API_TOKEN`, plus your login email in `ADMIN_EMAILS` |
| Actual video playback/upload | Above, plus a real bunny.net Stream library for `BUNNY_LIBRARY_ID`/`BUNNY_API_KEY`/`BUNNY_TOKEN_AUTH_KEY` |
| Share-link emails sending automatically | Above, plus a real Resend account + verified domain for `RESEND_API_KEY`/`EMAIL_FROM` |

There is no mocking layer for bunny.net, Auth0, or Upstash in this repo — running the app
against fakes/stubs for manual QA is out of scope here; see `validation-and-qa` for what
*is* automated (pure-logic Vitest tests only, no integration mocks).

---

## 5. Add-a-new-env-var checklist

Follow this exact order — skipping steps is how vars end up half-wired.

1. **Read it defensively, following the existing pattern.** Don't call
   `process.env.YOUR_VAR` inline scattered across a file — use a trimmed local helper the
   way `lib/bunny.js:11` and `lib/email.js:8` do:
   ```js
   const env = (name) => (process.env[name] || "").trim();
   ```
   The `.trim()` matters — a stray newline from a pasted secret in Vercel's UI has broken
   TUS/embed signatures before (README "Common issues": "Upload fails with HTTP 401").
2. **Add it to `README.md`'s env-var table** in the right section (Required / Optional —
   email / Optional — other). Route the actual prose-writing to `docs-and-writing` if you
   want house-style review, but the row must exist before you call this done.
3. **Add it to `.claude/skills/environment-and-config/references/env.local.template`**
   (this skill's own template) with a comment explaining what it does and its default/
   fallback behavior when unset.
4. **Add it to Vercel**: Settings → Environment Variables → New. Pick the correct
   environment scope(s) — Production / Preview / Development (see §6). Get this wrong and
   the var works on your Preview deploy but silently isn't there in Production, or vice
   versa.
5. **Redeploy.** Env var changes in Vercel apply **only to new deployments** — an existing
   running deployment keeps its old (or missing) value until redeployed. This is called out
   explicitly in README ("After adding or changing any variable, **redeploy**"). Trigger the
   redeploy via `run-and-operate`.
6. **If the build itself reads the var** (i.e. it's needed for `next build` to succeed, the
   way the Auth0 four are), add a dummy value to the `env:` block in
   `.github/workflows/ci.yml`'s build step — otherwise CI's build will fail on every PR even
   though Vercel's real build would succeed with real values. Cross-check with
   `change-control` Gate 3, and update that skill's documented CI env block if you touch it.
7. **Never use `NEXT_PUBLIC_` for a secret.** Anything prefixed `NEXT_PUBLIC_` is bundled
   into client-side JS and is world-readable in the shipped bundle — today only
   `NEXT_PUBLIC_SITE_NAME` and `NEXT_PUBLIC_SENTRY_DSN` carry the prefix, and both are
   non-secret by design (a portal name, and a Sentry DSN, which is not treated as
   confidential). This is `change-control` non-negotiable #7 — don't create a second
   category of exception.

---

## 6. Vercel specifics

- **Environment scoping**: every var in Vercel's Settings → Environment Variables can be
  scoped to **Production**, **Preview**, and/or **Development** independently. A var set
  only for Production won't exist on `vercel dev` or Preview deploys. When in doubt for this
  app, set required vars (Auth0 five, `ADMIN_EMAILS`, bunny three, Redis two) across **all
  three** scopes with environment-appropriate values (e.g. different `APP_BASE_URL` per
  scope, since Preview URLs are dynamic per-deploy — check whether your Auth0 app's Allowed
  Callback URLs list needs a wildcard/multiple entries for Preview to work with login).
- **Storage tab auto-injection**: connecting a Redis/Upstash database via Vercel's Storage
  tab auto-creates `KV_REST_API_URL`/`KV_REST_API_TOKEN` (plus a few other Upstash vars this
  app doesn't use) as Environment Variables, scoped to whichever environments you attach the
  store to. If more than one storage database is connected to the same project, Vercel
  prefixes the injected names with the store's name — this is exactly the case §2's suffix
  resolution exists to handle. Don't hand-copy these into a second unprefixed var; let the
  suffix resolution do its job, or fix the ambiguity by setting the exact name if you hit
  the two-stores-same-kind case.
- **Redeploy requirement (repeat, because it's the #1 support issue)**: adding or editing a
  variable never touches an already-running deployment. You must trigger a new deployment
  (redeploy the same commit, or push a new one) for the change to take effect. See
  `run-and-operate` for how to trigger a redeploy safely.

---

## Provenance and maintenance

Written 2026-07-13 against commit-state matching `change-control`'s 2026-07-10 snapshot
(v1.6.0). The env-var inventory in §1 was built by grepping the repo directly, not copied
from README — re-run the grep below before trusting any row on a future date, since new
vars are easy to add without updating this file.

| Volatile claim | Re-verify with |
|---|---|
| Full env var inventory (code side) | `grep -rn "process.env" --include="*.js" lib/ pages/ components/ next.config.js sentry*.js instrumentation*.js proxy.js` |
| README's documented env vars, for cross-check | `grep -n "AUTH0\|APP_BASE_URL\|ADMIN_EMAILS\|BUNNY_\|KV_REST\|UPSTASH_\|RESEND\|EMAIL_\|SITE_NAME\|SENTRY\|NEXT_PUBLIC" README.md` |
| Suffix-resolution logic unchanged | `sed -n '1,32p' lib/redis.js` |
| CI's build-only minimal env block | `sed -n '1,50p' .github/workflows/ci.yml` (also mirrored in `change-control` Gate 3 — keep both in sync if either changes) |
| Approval fails-closed semantics unchanged | `sed -n '1,50p' lib/guard.js` (look for the "Approval fails closed" comment) |
| Node engines requirement | `grep -A2 '"engines"' package.json` |
| No `.env.example` exists at repo root (gap this skill's template fills) | `ls -a . \| grep -i env.example` (expect no output at repo root — the template lives only under this skill's `references/`) |

If you find a var in code that isn't in this table, or a row here that no longer matches
code, fix this file in the same PR — this skill is the single source of truth for config,
and a stale inventory is worse than none.
