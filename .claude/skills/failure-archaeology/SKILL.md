---
name: failure-archaeology
description: The chronicle of every settled incident and deliberate-looking oddity in the Marine Video Portal repo. Load this BEFORE re-attempting anything that looks already-tried, before "fixing" something that looks wrong but is intentional, when a history/why question comes up ("why is this disabled", "why does this look weird", "has this broken before"), or before touching ESLint config, lib/redis.js, lib/bunny.js signing code, the homepage data-fetch path, or CI workflow permissions. Prevents re-litigating closed battles and re-breaking things that were broken on purpose to fix a real incident.
---

# Failure archaeology — Marine Video Portal

This file is the incident log for `/home/user/fable-video` (Marine Video Portal,
v1.6.0, first release 2026-07-07). It exists because the owner's doctrine is explicit:
**no costly failures beyond what git already shows** — meaning every past mistake must
stay visible and legible so no agent re-spends the cost of discovering it again. Git
history is the source of truth; this file is a curated index into it, not a replacement
for it.

**Ground-truth rule for this file**: every claim below is tagged either
`[git-verified]` (checked against an actual `git show`/`git diff` in this repo — you can
re-run the cited command yourself) or `[reported]` (came from session context / operator
notes, consistent with what the diff shows but not itself provable from the diff, e.g.
an operational event like a blocked push that leaves no commit). Never upgrade a
`[reported]` claim to `[git-verified]` without actually re-checking it.

## When NOT to use this skill

| You are trying to... | Use instead |
|---|---|
| Decide which gates/checks apply to a change you're about to make | `change-control` |
| Understand a system invariant or why the architecture is shaped this way (not a past incident, but a standing rule) | `architecture-contract` |
| Respond to a NEW or currently-open CodeQL/security alert | `security-response` (this file only indexes what happened; open CodeQL items are listed below but triaged there) |
| Bump a dependency or fix an install/peer-dependency failure | `dependency-currency` |
| Debug a CURRENT runtime failure you haven't diagnosed yet | `debugging-playbook` (once diagnosed, check here for whether it's a repeat) |
| Look up bunny.net/Auth0/Upstash/Resend API specifics | `domain-reference` |
| Add/change environment variables or config files | `environment-and-config` |
| Deploy, redeploy, or operate the running app | `run-and-operate` |
| Write or extend tests | `validation-and-qa` |
| Write README/CHANGELOG/docs prose, or record a NEW incident here | `docs-and-writing` (then land the entry in this file per the template below) |
| Plan and ship a whole feature end to end | `feature-shipping-campaign` |

Use **this** skill when you're about to change something and it might already have a
history — a prior fix, a prior revert-and-redo, or a reason it looks the way it does.

## How to read the incident log

Columns: **ID** · **Date** (UTC, from commit) · **Symptom** · **Root cause** ·
**Evidence** · **Resolution** · **Status** · **DO-NOT list**. The DO-NOT list is the
important column — it's what a future agent must not "fix," revert, or retry.

### Quick index

Scan this before reading full entries — jump straight to the ID that matches what
you're touching.

| ID | One-line symptom | Status | Touches |
|---|---|---|---|
| FA-1 | ESLint 10 crashed `npm run lint` entirely | Resolved, pin still active | `package.json`, `eslint.config.mjs` |
| FA-2 | `react-hooks/set-state-in-effect` false-flagged effect-driven fetches | Resolved | `eslint.config.mjs` |
| FA-3 | Admin panel failed silently — no error in logs | Resolved, now a standing rule | all `pages/api/**` catches |
| FA-4 | Redis client init failed — Vercel-prefixed env var name | Resolved | `lib/redis.js` |
| FA-5 | Key-prefix rename orphaned all pre-2026-07-09 Redis data | **Open (latent)** | `lib/redis.js`, `lib/theme-client.js`, `pages/_document.js` |
| FA-6 | Homepage + search/filter/pagination felt slow | Resolved | `lib/bunny.js`, `lib/videoList.js`, `pages/index.js` |
| FA-7 | CodeQL: CI workflow missing explicit permissions | Resolved | `.github/workflows/ci.yml` |
| FA-8 | Git tag push blocked by remote-session proxy policy | Resolved (workaround) | operational only, no file |
| FA-9 | Version reads `1.6.0` on the first release | Not a bug, closed | `package.json` |

---

### FA-1 — ESLint 10 crashed lint entirely

| Field | Detail |
|---|---|
| Date | 2026-07-04 |
| Symptom | `npm run lint` crashed with `scopeManager.addGlobals is not a function` instead of running any rule |
| Root cause | `eslint-config-next@16` declares a peer range of `eslint >=9` but its `typescript-eslint` parser stack in practice only works against the ESLint 9.x line; ESLint 10's changed internal API broke it |
| Evidence `[git-verified]` | commit `f2d3a30` — `package.json` devDependency `"eslint": "^10.6.0"` → `"^9.39.0"`; also bumped `actions/checkout` and `actions/setup-node` from v4→v5 in `.github/workflows/ci.yml` in the same commit (unrelated cleanup, Node 20 deprecation) |
| Resolution | Pin `eslint` to `^9.39.0` in `package.json` |
| Status | Resolved, but **pin is still in effect** — this is a live exception, not a historical footnote (see DELIBERATE ODDITIES) |
| DO-NOT | Do not bump `eslint` to `^10.x` or later without first confirming `eslint-config-next` (currently pinned to `^16.2.10`) has published support for it — check `dependency-currency` for the re-check condition before touching this |

### FA-2 — react-hooks/set-state-in-effect false-flagged the app's core data-fetch pattern

| Field | Detail |
|---|---|
| Date | 2026-07-04 |
| Symptom | Lint flagged every `useEffect` data loader (e.g. homepage video fetch) as a rule violation |
| Root cause | `eslint-plugin-react-hooks@7`'s new `react-hooks/set-state-in-effect` rule statically flags any `setState` call inside a `useEffect`, but its analysis cannot see past an `await` boundary — every flagged call actually happens *after* an awaited `fetch()`, which is the intended and only data-fetching pattern in this Pages-Router app (no data library is used) |
| Evidence `[git-verified]` | commit `eef72fb` — `eslint.config.mjs` diff adds a rule override block with the rationale comment: *"Effect-driven data fetching is the intended pattern here (Pages Router, no data library): the loaders only call setState after an awaited fetch, but the rule's static analysis cannot see the await boundary..."*; also renamed the anonymous default export to satisfy `import/no-anonymous-default-export` in the same commit |
| Resolution | `"react-hooks/set-state-in-effect": "off"` in `eslint.config.mjs`, with the rationale left as a comment directly above the line |
| Status | Resolved, permanent as long as the Pages Router + effect-fetch pattern is the architecture |
| DO-NOT | Do not re-enable this rule to "clean up lint config" without rewriting every `useEffect` loader to a different data-fetching pattern first (that's an architecture change, not a lint fix) — do not silently re-enable and then suppress each individual call site with inline disables either, that's worse than the current single documented override |

### FA-3 — Admin panel failed with unexplainable "Could not load viewers" and empty logs

| Field | Detail |
|---|---|
| Date | 2026-07-09 |
| Symptom | Every admin data tab (viewers, shares, settings, analytics, etc.) failed in production with a generic "Could not load X" / "Could not save X" message, and Vercel function logs showed nothing useful to diagnose from |
| Root cause | Every `catch` block across ~15 API files swallowed its error (`catch { return res.status(502)...}` with no logging) — so when the underlying Redis client actually failed, the real error (`[Upstash Redis] Redis client was initialized without url or token. Failed to execute command.`) never reached the logs |
| Evidence `[git-verified]` | commit `1e01860` — touches 15 files, ~29 catch blocks, adding `console.error("<label>:", err)` before every existing generic error response; e.g. `pages/api/admin/viewers.js`: `catch { ... }` → `catch (err) { console.error("Could not load viewers:", err); ... }` (same pattern at all 3 catch sites in that file). Commit message states the loader logic itself was verified correct against the real `@upstash/redis` SDK — the bug was pure silence, not logic |
| Resolution | `console.error(label, err)` added immediately before every 5xx response, across all data-layer catches |
| Status | Resolved and now a standing rule (see `change-control` non-negotiable #2) |
| DO-NOT | Do not add a new `catch` block anywhere in `pages/api/**` or `lib/**` without a `console.error` before the error response — a silent catch here is exactly what caused this incident and is now a repo-wide rule, not just a one-off fix |

### FA-4 — Root cause of FA-3: Vercel injected a prefixed Redis env var name

| Field | Detail |
|---|---|
| Date | 2026-07-09 |
| Symptom | Once FA-3's logging landed, the real error surfaced: `Redis client was initialized without url or token`, even though the Upstash store was correctly connected and scoped to Production/Preview in Vercel |
| Root cause | The Vercel project has more than one storage connection; when that happens Vercel injects the store's env vars with a store-name prefix instead of the plain name — confirmed in production the actual variable was `fablevideo_KV_REST_API_URL`, not `KV_REST_API_URL`. The old code only checked the exact unprefixed names |
| Evidence `[git-verified]` | commit `84dfbe3` — `lib/redis.js` adds `envBySuffix(name)`, which checks the exact name first, then falls back to `Object.keys(process.env).find(k => k.endsWith(`_${name}`))`; `redis()` now calls `envBySuffix("KV_REST_API_URL") \|\| envBySuffix("UPSTASH_REDIS_REST_URL")` (and the token equivalent). README "Common issues" section gained a paragraph documenting the gotcha in the same commit |
| Resolution | Resolve `KV_REST_API_URL`/`KV_REST_API_TOKEN` (and the `UPSTASH_REDIS_REST_*` equivalents) by suffix match, preferring an exact unprefixed match when one exists (no regression for single-store setups) |
| Status | Resolved |
| DO-NOT | Do not hand-read `process.env.KV_REST_API_URL` (or the token) anywhere outside `lib/redis.js` — always go through `redis()`/`k()`. If a *new* multi-store Vercel project shows the same symptom for a *different* env var family, extend `envBySuffix`'s call sites, don't hardcode the new prefixed name |

### FA-5 — Redis key-prefix rename orphaned all pre-existing data

| Field | Detail |
|---|---|
| Date | 2026-07-09 |
| Symptom | None yet observed as a user-facing bug at time of writing — this is a **latent** data-loss trap, flagged proactively. After the rename, the portal looks fresh: viewer list, settings, custom order, and theme all silently reset to defaults for any data written before the rename |
| Root cause | Commit renamed the app's internal Redis key namespace for branding (`pvp:` → `fablevideo:`) with **no data migration**. Every key goes through `k()` in `lib/redis.js`, so the rename was a one-line `PREFIX` change, but any key written under the old prefix before 2026-07-09 is now unreachable — the code only ever reads/writes `fablevideo:*` |
| Evidence `[git-verified]` | commit `c37919e` — `lib/redis.js`: `const PREFIX = "pvp"` → `const PREFIX = "fablevideo"`; same-commit companion renames: `lib/theme-client.js` `THEME_CACHE_KEY = "pvp:theme"` → `"fablevideo:theme"`, and the matching literal inside the inline pre-paint script in `pages/_document.js`. Commit message explicitly states: *"All data is stored fresh so there's no migration: Redis keys... simply repopulate under the new prefix."* — a stated, deliberate decision, not an oversight |
| Resolution | None performed — repopulation was accepted as the resolution. Old `pvp:*` keys still exist in Redis (Upstash doesn't auto-expire without a TTL) but are inert |
| Status | **Open / latent** — data loss already happened as a side effect (silent), recovery is possible but not yet attempted |
| DO-NOT | Do not assume `pvp:*` keys are gone — they are very likely still sitting in Redis, unread. Do not write a "cleanup" script that deletes `pvp:*` keys without first checking whether the recovery path below is wanted. Do not build any new feature that reads keys without going through `k()` — a second silent-rename incident is exactly what rule #5 in `change-control` guards against |

**Candidate recovery runbook** (not yet executed, `[reported]` — do not run unprompted):
enumerate `pvp:*` keys via a read-only diagnostics script (see `diagnostics-and-tooling`),
compare against current `fablevideo:*` equivalents, and copy over any that are still
empty/default under the new prefix. Only do this if the pre-2026-07-09 data actually
matters to the owner — ask first. See OPEN ITEMS below.

### FA-6 — Homepage was slow (three-commit arc)

| Field | Detail |
|---|---|
| Date | 2026-07-04 (three commits same day: `68ee934`, `16a5c43`, `b9e2b22`) |
| Symptom | Homepage felt slow to first paint, and search/collection-filter/pagination each felt laggy (a couple of seconds per keystroke or click) |
| Root cause | Three compounding causes: (1) videos were fetched **client-side after hydration** (`pages/index.js` had no `getServerSideProps` video fetch), forcing a full extra round trip plus a possible cold serverless-function start before anything appeared; (2) `listAllVideos()` in `lib/bunny.js` fetched multi-page bunny.net libraries **one page at a time in sequence**; (3) every search/filter/pagination interaction re-fetched the whole library from bunny.net **with no caching**, and separately the signed embed URL carried `preload=true`, making bunny's player eagerly buffer bytes before the viewer pressed play |
| Evidence `[git-verified]` | `68ee934`: adds `lib/videoList.js`, server-renders the first page via `getServerSideProps` in `pages/index.js`, rewrites `listAllVideos` to fetch page 1 first (for the total count) then remaining pages via `Promise.all(...)`, and adds a 4-second `videoListCache` with `invalidateVideoListCache()` called from `createVideo`/`updateVideo`/`deleteVideo`. `16a5c43` (author `Devin`, not the Claude sessions — the one human-authored performance commit): `lib/bunny.js` embed URL string drops `&preload=true`. `b9e2b22`: reworks `lib/videoList.js`/`pages/index.js` so the **entire** capped library is fetched once (SSR first, client refetch only on failure) and search/collection-filter/pagination all run as in-browser `Array.filter`/`.slice()` against that one list — no more per-keystroke network round trip |
| Resolution | SSR first load + parallel multi-page fetch + 4s promise cache + client-side filter/search/paginate + no eager preload |
| Status | Resolved |
| DO-NOT | Do not reintroduce a per-keystroke or per-filter-click `fetch("/api/videos?...")` call — that is the exact pattern `b9e2b22` removed. Do not add a bunny.net mutation (create/update/delete video) without calling `invalidateVideoListCache()` afterward (see `change-control` non-negotiable #6) — the 4s cache will otherwise serve stale data. Do not re-add `preload=true` (or any eager-buffer param) to `signEmbedUrl()` without a specific reason and a note here |

### FA-7 — CodeQL workflow-permissions alert (real finding, fixed)

| Field | Detail |
|---|---|
| Date | 2026-07-10 |
| Symptom | CodeQL flagged the GitHub Actions workflow for not declaring explicit permissions (implicit default permissions are broader than necessary) |
| Root cause | `.github/workflows/ci.yml` had no top-level `permissions:` block, so it ran with the (broader) repository-default token permissions instead of least-privilege |
| Evidence `[git-verified]` | commit `7968919` — adds `permissions:\n  contents: read` at the workflow's top level, above the `jobs:` key |
| Resolution | Explicit `contents: read` permission block added |
| Status | Resolved |
| DO-NOT | Do not remove the `permissions: contents: read` block, and do not widen it (e.g. add `write` scopes) without a specific new need — CI here only needs to read the repo to lint/test/build. This was 1 of 4 CodeQL alerts raised 2026-07-10; the other 3 are open false positives — see OPEN ITEMS |

### FA-8 — Git tag push blocked by remote-session proxy policy (operational, no commit)

| Field | Detail |
|---|---|
| Date | 2026-07-07 (reported) |
| Symptom | Pushing the `v1.6.0` git tag (and creating the GitHub Release) from a remote Claude session failed |
| Root cause | The remote environment's outbound proxy policy blocks tag pushes from this kind of session (distinct from ordinary branch/commit pushes, which work) |
| Evidence | `[reported]` — this is an operational event, not a code change, so it leaves no commit to verify. Consistent with: no tag-push commits exist in `git log`, and the release notes (`CHANGELOG.md`, added in `8327d0e`) describe v1.6.0 as already released by 2026-07-07 |
| Resolution | Tag and GitHub Release were created via the GitHub web UI instead of `git push --tags` |
| Status | Resolved (workaround), root policy still in place |
| DO-NOT | Do not retry `git push --tags` (or any tag push) from a remote Claude Code session expecting it to suddenly work — go straight to the GitHub web UI (or ask the user to do it) instead of burning a retry loop rediscovering this block. This skill's own **hard rule** already forbids mutating git commands here regardless |

### FA-9 — Version starts at 1.6.0, not 1.0.0 (looks like a bug, isn't)

| Field | Detail |
|---|---|
| Date | 2026-07-04 (present since the very first commit) |
| Symptom | `package.json`'s `"version"` field reads `"1.6.0"` on what `CHANGELOG.md` and the README both call the **first** release |
| Root cause | Not a root cause — there is no defect. `1.6.0` was simply the version number chosen for `package.json` from the initial commit onward; nothing derives it from a "1.0, 1.1, ... 1.6" release sequence that ever existed in this repo |
| Evidence `[git-verified]` | `git show 3848bc0:package.json` — `"version": "1.6.0"` present in the very first commit. `git log --follow -p -- package.json` shows exactly one line ever touching `"version"` (the initial add) — it has never been bumped or edited |
| Resolution | N/A — nothing to resolve |
| Status | Not a bug, closed as intentional |
| DO-NOT | Do not "fix" this by resetting `package.json` version to `1.0.0`, and do not add a changelog entry implying versions 1.0.0–1.5.x ever existed — they didn't. If you need to bump the version for a real future release, bump forward from `1.6.0` normally |

---

## DELIBERATE ODDITIES

Things that look like bugs, sloppiness, or leftover debt but are intentional. Each row
names the defense and where the reasoning lives. If you're about to "clean up" any of
these, stop and read the cited source first.

| Oddity | Looks like | Actual defense | Where documented |
|---|---|---|---|
| No `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml` committed | Missing lockfile = sloppy, non-reproducible builds | Deliberate latest-versions policy: Vercel and CI install fresh every time, by design, so dependencies always resolve to the newest version matching `package.json`'s caret ranges | `.gitignore:1-6` comment: *"dependencies — installed by Vercel/CI at deploy time; no lockfile is committed (a stray lockfile out of sync with package.json is a common deploy failure)"*; `change-control` non-negotiable #4 |
| `react-hooks/set-state-in-effect` disabled in `eslint.config.mjs` | Someone silenced a real lint rule to make errors go away | Documented false-positive on the app's intended effect-driven fetch pattern | FA-2 above; rationale comment directly in `eslint.config.mjs` |
| `eslint` pinned to `^9.39.0` while everything else tracks latest | Contradicts the "dependencies on latest" doctrine | Dated, scoped exception: ESLint 10 crashes `eslint-config-next@16` today. Re-check condition: `eslint-config-next` publishing ESLint-10 support | FA-1 above; `dependency-currency` should carry the re-check trigger — verify that skill states this explicitly when it exists |
| `crypto.createHash("sha256")` used for security tokens in `lib/bunny.js` (embed token ~line 150, TUS upload signature ~line 161, thumbnail token ~line 188, as of 2026-07-13) | "Password hash with insufficient computational effort" (SHA-256 is not a slow/salted password hash) | Not a password hash at all — these are HMAC-style request-signing schemes **mandated by bunny.net's own API contract** (bunny.net specifies plain SHA-256 of `key+params` for embed/TUS/CDN token auth). Using bcrypt/argon2 here would not interoperate with bunny's verification | CodeQL alerts #2-4, raised 2026-07-10, currently OPEN pending formal dismissal — see OPEN ITEMS and `security-response` |
| Rate limiting fails OPEN (`lib/ratelimit.js`: `catch { return true; }`) while approval fails CLOSED (`lib/guard.js`: `catch { approved = false; }`) | Inconsistent error handling — pick one failure mode | Deliberate asymmetry: rate-limit failing open means an infra hiccup never locks out real users; approval failing closed means an infra hiccup never leaks video data to an unapproved viewer. Flipping either would trade a cost problem for a security problem or vice versa | `lib/ratelimit.js` header comment; `lib/guard.js:29` comment `// Approval fails closed — no video data leaks on an infra error.`; `change-control` non-negotiable #12; see `architecture-contract` |
| `package.json` version is `1.6.0` on the first-ever release | Looks like 5 prior releases are missing from history | No prior releases ever existed — see FA-9 | FA-9 above |
| ~29 near-identical `console.error(label, err)` catch blocks across 15 API files | Copy-paste sprawl a linter should dedupe | Doctrine, not sloppiness: FA-3 happened because catches were silent. Uniform, unabstracted logging at every catch site is intentional so no future catch can quietly skip it via a shared helper that gets bypassed | FA-3 above; `change-control` non-negotiable #2 |

## OPEN ITEMS

Honest list of things that are unresolved as of 2026-07-13. Do not treat any of these as
closed; do not "fix" them unprompted either — most need an owner decision first.

| Item | State | What would close it |
|---|---|---|
| CodeQL alerts #2-4 ("password hash with insufficient computational effort" at `lib/bunny.js` — 3 `createHash("sha256")` call sites) | **Open**, believed false positive (see DELIBERATE ODDITIES) | Formal dismissal in GitHub's CodeQL alert UI with the bunny.net-API-mandate justification recorded in the dismissal reason. Route through `security-response` |
| Orphaned `pvp:*` Redis keys from the FA-5 rename | **Open**, latent, no recovery attempted | Owner confirms whether pre-2026-07-09 data (viewer list, settings, order, theme) is worth recovering. If yes: candidate runbook is enumerate `pvp:*` via a read-only diagnostics script, diff against current `fablevideo:*` values, copy over anything still at default. **Never run this unprompted** |
| No `.github/dependabot.yml` in this repo | **Open**, candidate only | Owner decision: dependabot's PR-based bumps are somewhat in tension with the no-lockfile / always-fresh-install doctrine (`change-control` non-negotiable #4) — worth resolving that tension deliberately before adding one, not by default. Route through `dependency-currency` |

## HOW TO ADD AN ENTRY

Every future incident lands here — this file is never allowed to go stale relative to
git. Use `docs-and-writing` for prose polish, but the entry itself is written here,
not filed elsewhere.

**When to add one**: any time a change was made *because something broke or was
wrong* (not a routine feature addition), or any time you catch yourself about to
"fix" something that turns out to be intentional (add it to DELIBERATE ODDITIES
instead, or both if it started as an incident).

**Template** — copy this block, fill it in, append it as a new `### FA-N` section
before DELIBERATE ODDITIES, and increment N:

```
### FA-N — <short symptom, matches commit subject where possible>

| Field | Detail |
|---|---|
| Date | YYYY-MM-DD (UTC, from `git show --format=%cd --date=short <hash>`) |
| Symptom | What was actually observed, in plain terms — the error message or user-visible behavior |
| Root cause | What was actually wrong, one level deeper than the symptom |
| Evidence `[git-verified]` | commit `<hash>` — cite the specific file(s)/line(s) changed and quote the load-bearing diff fragment or commit-message sentence |
| Resolution | What the fix actually did |
| Status | Resolved / Open / Resolved (workaround) — pick one, be honest |
| DO-NOT | The specific thing a future agent must not redo, revert, or re-attempt, and why |
```

Rules for a good entry:
- Verify against `git show <hash>` yourself before writing "git-verified" — don't
  trust a commit message's prose alone, read the diff.
- If there's no commit (an operational event, a config change made outside git, a
  decision with no code trace), mark it `[reported]` and say why no diff exists.
- The DO-NOT list is mandatory and is the actual point of the entry — a story
  without a DO-NOT is just changelog trivia.
- Keep symptom/root-cause in plain, zero-context language; assume the reader has
  never seen this repo before.

## Provenance and maintenance

Written 2026-07-13 against `HEAD` = `8dcb237` (12 commits total, no reverts, v1.6.0
first release 2026-07-07). Every `[git-verified]` claim above was checked against the
actual diff on that date via `git show <hash>`; every `[reported]` claim is flagged as
such and should be re-verified against the source (session logs, the owner) before
being treated as fact. Line numbers cited for `lib/bunny.js` (FA-7/oddities table) are
current as of this file's writing — re-grep before citing them again, they drift as
the file is edited. This file has no expiry; update it in place (new `### FA-N`
section) the moment a new incident lands — never let git outrun this index.
