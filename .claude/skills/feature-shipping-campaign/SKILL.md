---
name: feature-shipping-campaign
description: The decision-gated, executable plan for shipping a new feature into the Marine Video Portal — a new endpoint, admin capability, page, or user-visible behavior — without breaking anything. Use when asked to "add a feature", "build X into the portal", "add an endpoint/page/admin capability", or any other end-to-end shipping task that goes from idea to a merged, deployed, verified change. This is the capstone skill: it sequences architecture-contract, change-control, validation-and-qa, environment-and-config, docs-and-writing, and run-and-operate into one ordered path with a GATE (expected output + if-not branch) at the end of every phase. Do not use it for docs-only edits, pure dependency bumps, or bug fixes — see "When NOT to use this skill" below.
---

# Feature shipping campaign — Marine Video Portal

The owner's definition of success for this repo, verbatim: **"features shipped safely,
security."** Not "features shipped fast." This skill is the executable path from "build X"
to a feature running in production that has not weakened any invariant. It does not
replace the sibling skills — it sequences them. Every phase below ends in a **GATE**: a
command or checklist with an EXPECTED output and an explicit "if you see something else,
do this" branch. Do not skip a gate because the change "feels small" — Phase 0 exists
precisely to route small changes elsewhere before you invest in the rest of this skill.

Written 2026-07-13. Repo is `marine-video-portal` v1.6.0 on `main`, Pages Router + React
19 on Vercel, deployed and live. Facts below are volatile; re-verify per the Provenance
table at the end before relying on any specific number.

## When NOT to use this skill

| If your change is... | Use instead |
|---|---|
| Only `README.md`, `CHANGELOG.md`, comments, or `.claude/skills/**` — no code | `change-control`'s Docs-only class, then `docs-and-writing` directly |
| Only a `package.json` version bump, no new capability | `dependency-currency` directly |
| Restoring behavior that used to work (something is broken right now) | `debugging-playbook` first. Only come back here if the fix grows into a genuinely new capability along the way |
| A trivial, self-contained tweak (copy text, a CSS value, a default constant) with no new endpoint/data/page | `change-control` directly — run its gates, skip this skill's overhead |
| Responding to a CodeQL/Dependabot alert or a leaked secret | `security-response` |
| You already know the invariants and just need the gate commands | `change-control` |

Use **this** skill when the change adds something a user or admin could not do before:
a new endpoint, a new admin action, a new page, a new piece of stored data, a new
integration. If you're unsure which bucket you're in, Phase 0 below has the full decision
table — walk it before doing anything else.

---

## PHASE 0 — Scope & classify

### 0.1 Is this even a feature?

Walk the "When NOT to use this skill" table above first. If none of those rows match,
proceed.

### 0.2 Size check — detours before you start

- **Needs a new npm dependency?** Stop and detour to `dependency-currency` for the
  latest-versions doctrine and the ESLint-9.x exception (non-negotiable rule 9 in
  `change-control`) before adding it to `package.json`. Come back here once the dependency
  is in and `npm install` (no lockfile committed) is clean.
- **Needs a new environment variable?** Do not add it ad hoc. Queue `environment-and-config`
  section 5's "Add-a-new-env-var checklist" now — you'll need it again at Phase 5 (docs)
  and Phase 6 (Vercel redeploy: a code merge alone does **not** apply a new env var, per
  `change-control` section 2 step 5 and `run-and-operate` section 4).

### 0.3 Write the done-criteria FIRST

Before touching any file, write down (paper, PR draft, wherever — just write it before
Phase 1):

1. **One or two sentences**: what can a user or admin newly do after this ships that they
   could not do before?
2. **Numbered manual smoke steps** that prove it — using the same "log in as an approved
   viewer" / "log in as an admin" pattern the app already assumes elsewhere. Use
   `validation-and-qa` section 6's `Done-criteria: <feature name>` template verbatim —
   write it now so Phase 4 is just "run what I already specified," not "invent acceptance
   criteria after the fact."
3. **Which automated tests** (existing or new) cover the pure-logic part of this, if any.

**GATE 0** — you can state the done-criteria in under 5 sentences, and you've classified
the change as a genuine feature. If you cannot state it that briefly, the scope is
probably still too vague to safely start Phase 1 — narrow it first.

---

## PHASE 1 — Pre-flight

Run from `/home/user/fable-video`.

### 1.1 Clean working tree

```bash
git status --porcelain
```

**Expected:** empty output. **If not empty:** read what's listed before doing anything.
As of 2026-07-13 the *only* legitimate non-empty case is an untracked `.claude/` directory
(this skill library itself being authored) — that is documentation, not application code,
and is safe to leave alone or ignore. If instead you see modified/staged files under
`pages/`, `lib/`, `components/`, or `package.json` that you did not create, **STOP** —
someone else's in-progress work is in this checkout. Do not build your feature on top of
it; confirm with the owner before proceeding.

### 1.2 Fresh feature branch off latest main

```bash
git fetch origin main
git switch main && git pull
git switch -c feature/<short-slug>
```

**Expected:** branch created, `git log -1` shows the same commit as `origin/main`.
Never commit directly to `main` (observed convention across all commits in this repo's
history — see `change-control` section 2).

### 1.3 Dependencies installed

```bash
npm install
```

**Expected:** exits 0, no `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml` created
(`.gitignore` blocks them by design — non-negotiable rule 4). If install fails, that's
`dependency-currency` territory, not this skill.

### 1.4 Baseline gates green BEFORE touching anything

```bash
npm run lint
npm test
```

**Expected — lint:** exit 0, output is exactly the script banner (`> marine-video-portal@1.6.0 lint` / `> eslint .`), nothing else.
**Expected — test:** ends with
```
 Test Files  4 passed (4)
      Tests  24 passed (24)
```
These are today's baseline counts (4 files / 24 tests, all in `lib/__tests__/`). Write
them down — Phase 4 will ask you to compute the new totals.

**Build:** do not run `npm run build` yourself if any other agent/process might be
touching this checkout concurrently — builds write to `.next/` and collide. Cite the
verified baseline instead: build passed with exit 0 on 2026-07-10 using the exact env
one-liner in `.github/workflows/ci.yml` (lines ~35-46), ending in a printed route table.
Only run it yourself in Phase 4 once you're confident you have exclusive use of the
checkout, and CI's build on your PR is the authoritative check regardless.

**GATE 1** — lint exit 0 and test shows `4 passed (4)` / `24 passed (24)` (or your last
confirmed baseline, re-verified). **If baseline is already red:** STOP. Do not write
feature code on top of a red baseline — go to `debugging-playbook`, fix it, get back to
green, and only then start this skill's Phase 2. A feature diff on top of pre-existing
breakage makes both code review and CI bisection meaningless.

---

## PHASE 2 — Design gate

Load `architecture-contract` now if you have not already — every question below maps to
one of its lettered invariants. Answer every question **in writing** (PR description draft
is fine) before writing implementation code.

1. **Which access tier does this need, and which guard function enforces it?**
   Options, from `lib/guard.js`: no guard (public), `requireUser` (logged in, any
   identity), `requireApproved` (approved viewer — fails CLOSED on infra error, invariant
   c), `requireAdmin` (admin only — invariant b: every `/api/admin/*` route calls it
   independently, never relying on the page-level SSR gate alone). State which, and why.

2. **Does this create new stored data?** If yes: what Redis key(s), built via `k(...)`
   from `lib/redis.js` (invariant e — never a hand-built string), what shape (string /
   hash / set / list), and what TTL (permanent like `k("viewers")`, or TTL-native like
   shares — see `lib/shares.js`)? Queue this key as a new row for `domain-reference`
   section 4's "Complete key inventory" table (Phase 5).

3. **Does this call any bunny.net mutation** (create/update/delete video, or anything
   that changes the library)? If yes, it MUST call `invalidateVideoListCache()`
   immediately after the API call (invariant f — currently 3 call sites at
   `lib/bunny.js:97,106,112`; a 4th mutation should bring that count to 4). If your
   feature only *reads* bunny/Redis data without mutating the library, say so explicitly
   and skip this.

4. **Is this endpoint expensive or abusable** (hits a paid external API, sends email, or
   is otherwise cheap to spam)? If yes, rate-limit it with `allowRequest(name, id, tokens,
   window)`, copying an existing budget as precedent — e.g.
   `pages/api/admin/share.js:20`: `allowRequest("share", admin, 30, "1 h")`. State the
   budget and why. If the endpoint is a cheap, admin-only Redis toggle with no external
   call, justify skipping this explicitly rather than silently omitting it (non-negotiable
   rule 10 covers "expensive or abusable," not "every endpoint").

5. **Does this mutate state as an admin action?** If yes, call
   `logAction(admin, "noun.verb", detail)` after the mutation succeeds — never as a
   precondition, never let its failure block the action (invariant j, rule 11).

6. **Does this involve email?** If yes, follow the inert-until-configured pattern:
   `emailEnabled()` gates whether email is attempted at all, and the primary action (e.g.
   creating a record) must succeed and return usable data regardless of email outcome —
   see `pages/api/admin/share.js:45-78` (invariant i).

7. **Does this need a new environment variable?** If yes, the full checklist from
   `environment-and-config` is queued (already noted in Phase 0.2) — and remember Phase 6
   needs an explicit Vercel redeploy, not just a merge.

8. **Does this touch the UI?** Pages Router only — no `app/` directory exists anywhere in
   this repo and none should be introduced by a routine feature (architecture-contract
   section 2, load-bearing decision).

9. **Does this compare "who is this user" anywhere?** Always through `normalizeEmail()`
   from `lib/auth.js` — never a raw `session.user.email ===` comparison (invariant a).

### Fenced-off list — never do any of these

- Never add an `app/` directory or any App-Router file.
- Never invent a new auth path around `requireUser`/`requireApproved`/`requireAdmin` —
  extend the existing guards, don't bypass them.
- Never put a secret in a `NEXT_PUBLIC_*` variable, client-side code, or component props.
- Never construct, log, or expose a direct bunny.net CDN file URL
  (`*.b-cdn.net/.../*.m3u8`, `play_720p.mp4`) — only `signEmbedUrl()`/`thumbnailUrl()`
  outputs, ever.
- Never commit a lockfile (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`).
- Never hand-build a Redis key string — always `k(...)` from `lib/redis.js`.
- Never write a `catch` block without `console.error("label:", err)` before the response.
- Never let a share-mismatch or share-gone response reveal the intended recipient or
  video title (invariant g).
- Never flip the fail-open/fail-closed asymmetry: approval fails CLOSED, rate limiting
  fails OPEN (invariant c) — always in that direction.
- Never bump ESLint past `^9.x` (non-negotiable rule 9; `eslint-config-next` breaks on 10).

### Design alternatives — one paragraph, ranked

Before implementing, write exactly **two** viable designs and pick one with a one-paragraph
"why." Default bias: **prefer extending an existing `lib/` module over creating a new
file** — e.g. add a function to `lib/store.js` (which already owns settings/viewers/order/
theme/progress) rather than inventing `lib/featured.js`, unless the new concept is a
genuinely separate domain the way `lib/shares.js` earned its own file (TTL-native records,
its own index set, its own recipient-privacy invariant). See the worked example below for
what this paragraph looks like in practice.

**GATE 2** — every numbered question above has a written answer, the fenced-off list has
been read against your plan, and the two-design paragraph exists. **If you can't answer
one of the numbered questions** (e.g. you don't know what tier this needs), that's a sign
the feature isn't scoped enough yet — go back to Phase 0.3's done-criteria and sharpen it.

---

## PHASE 3 — Implement, in dependency order

Order: **`lib/` → `pages/api/` → `pages/` (UI)**. Never write a route against a `lib/`
function that doesn't exist yet, and never write UI against a route that doesn't exist yet.

**Per-file loop**, repeated for every file you touch:

1. Write the file.
2. `npm run lint` — expect exit 0 (banner-only output). Fix immediately; don't accumulate
   lint debt across multiple files.
3. If what you just wrote is pure logic in `lib/` (no I/O side effect that needs mocking,
   like `applyOrder` in `lib/__tests__/order.test.js`), add or extend its test **now**, in
   `lib/__tests__/`, per `validation-and-qa` — not batched at the end of Phase 3.

### Skeleton A — new admin API route

Derived from the real structure of `pages/api/admin/viewers.js` (guard-first, per-method
branch, labeled `console.error` + 502 on every data-layer catch, `logAction` after a
successful mutation, `Allow` header on the unmatched-method fallback):

```js
// pages/api/admin/<new-route>.js
import { requireAdmin } from "../../../lib/guard";
import { logAction } from "../../../lib/audit";
// import whatever lib/store.js (or a new lib module) function you designed in Phase 2

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return; // requireAdmin already sent 401/403

  if (req.method === "GET") {
    try {
      return res.json({ /* ... */ });
    } catch (err) {
      console.error("Could not load <thing>:", err);
      return res.status(502).json({ error: "Could not load <thing>" });
    }
  }

  if (req.method === "POST") {
    // validate req.body here — 400 on bad input, same style as
    // pages/api/admin/share.js:30-35 (isValidEmail / videoId checks)
    try {
      // await allowRequest(...) first if Phase 2 flagged this endpoint as
      // expensive/abusable — see pages/api/admin/share.js:20
      // ... mutate ...
    } catch (err) {
      console.error("Could not save <thing>:", err);
      return res.status(502).json({ error: "Could not save <thing>" });
    }
    await logAction(admin, "<noun>.<verb>", "<detail>");
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
```

### Skeleton B — new store function

Derived from the real pattern in `lib/store.js` (every function is a thin, direct
`k()` + `redis()` call, no caching layer, no env var):

```js
// lib/store.js (extend the existing file — see Phase 2's "prefer extending" bias)
export async function getThing() {
  return (await redis().get(k("thing"))) || null;
}

export async function saveThing(value) {
  await redis().set(k("thing"), value);
}
```

Use a hash (`hset`/`hgetall`) if the data has named fields (like `k("settings")`), or a
set (`sadd`/`srem`/`smembers`) for membership (like `k("viewers")`), following whichever
existing function in `lib/store.js` your new field most resembles.

**GATE 3** — every file written passes `npm run lint` individually as you go, every new
pure-logic function in `lib/` has a test written in the same commit it was introduced,
and the file-touch order was lib → api → UI. **If lint fails on a file you just wrote:**
fix it before writing the next file — don't let failures stack up across the diff.

---

## PHASE 4 — Validation gate

### 4.1 Compute the new baseline

State explicitly: *"Before: 4 files / 24 tests. I added N test(s) in M file(s). After:
`4 + M` files / `24 + N` tests."* Do the arithmetic — don't estimate.

### 4.2 Run the full gate set

```bash
npm run lint
npm test
```

**Expected:** lint exit 0 (banner only); test ends with `Test Files  (4+M) passed (4+M)` /
`Tests  (24+N) passed (24+N)` matching your 4.1 arithmetic exactly. If the numbers don't
match what you predicted, something either didn't run or silently failed — investigate
before proceeding, don't just accept whatever number appears.

Run `npm run build` with the CI env one-liner (see Phase 1.4) if you have exclusive use of
the checkout; otherwise rely on the PR's CI build run in Phase 6 as the authoritative
build check, and say so in the PR.

### 4.3 Manual smoke — from your Phase 0.3 done-criteria

Actually execute the numbered manual smoke steps you wrote in Phase 0. Don't skip this
because the automated gates passed — none of lint/test/build exercises `pages/api/**` or
page behavior end to end (this repo's Vitest coverage is `lib/__tests__/` only).

### 4.4 Evidence rules

Paste the **actual terminal output** of lint/test (and build, if you ran it) into the PR
description, in the shape of `validation-and-qa` section 6's "Gate evidence" block
(predicted counts vs. observed output, checkbox per gate) — not a paraphrase, not "tests
pass." A reviewer (human or agent) should be able to read the PR and see the same gate
output you saw, not take your word for it.

**GATE 4** — computed totals match observed totals, manual smoke steps all pass, evidence
is pasted (not summarized). **If a gate fails here:** route by failure type — lint →
fix mechanically; test failure → `validation-and-qa`; build failure on missing env →
re-run with the CI one-liner; build failure on a code error → `debugging-playbook`. (Same
routing table as `change-control` section 5 — this skill doesn't duplicate it, just points
at it.)

---

## PHASE 5 — Docs gate

Hand off to `docs-and-writing` section 2's update matrix for exactly which prose files
need touching (README env-var tables, CHANGELOG, security notes) based on what Phase 2/3
actually changed. In addition, update the skill library itself if this feature added any
of the following — these are this skill's own obligations, not `docs-and-writing`'s:

| You added... | Update |
|---|---|
| A new Redis key | `domain-reference` section 4's "Complete key inventory" table |
| A new failure mode you discovered while building (a symptom + fix) | `debugging-playbook` |
| A new environment variable | `environment-and-config` section 5's checklist, steps 2-4 (README table, this skill's own `env.local.template`, Vercel) |
| Any new test, changing the 24-test baseline | `change-control`'s Gate 2 section (the `4`/`24` counts are written there explicitly and instruct future readers to update them), and `validation-and-qa` section 3's existing test map |

**GATE 5** — every row above that applies to your diff has a corresponding doc edit in
the same PR. **If you're not sure whether a row applies:** re-read your Phase 2 answers —
they already stated whether you added a key, an env var, etc.

---

## PHASE 6 — Ship gate

1. Push the branch: `git push -u origin feature/<short-slug>`.
2. Open a PR to `main`. Body = your Phase 0.3 done-criteria + Phase 4.4 evidence
   (pasted output), not a re-summary.
3. **Treat CI as the gate even if it isn't technically enforced.** Check the PR's checks
   tab / Actions tab; CI runs lint → test → build on Node 22 with a fresh `npm install`
   (no lockfile, so a version resolved fresh in CI can differ from what you had locally —
   if CI is red but your local run was green, suspect dependency drift and route to
   `dependency-currency`, per `change-control` section 5). Per `run-and-operate` section 2,
   whether GitHub branch protection actually *blocks* a merge on red CI is not verifiable
   from this checkout — don't assume it does. Wait for green regardless.
4. Merge only when CI is green. Do not force-merge on a red check even if the branch
   technically allows it.
5. Vercel auto-deploys `main` after merge — no manual deploy step for code.
6. **If Phase 0.2/2.7 queued a new environment variable:** adding it to Vercel and merging
   the PR is not enough — env-var changes only take effect on a **new** deployment, so you
   must trigger an explicit redeploy after setting the var. Hand off to `run-and-operate`
   for the redeploy mechanics.
7. **Post-deploy smoke:** re-run the Phase 0.3 / 4.3 manual smoke steps against the real
   production URL, not just against a local dev server. Hand off to `run-and-operate` for
   how to observe the live deployment.

**GATE 6 (final)** — CI green, PR merged, Vercel deployment shows the new commit live,
and the manual smoke steps pass **on production**, not just locally. **The feature is not
done until the post-deploy smoke passes on production.** A green CI run and a merged PR
are necessary but not sufficient — this repo has no automated coverage of `pages/api/**`
or page behavior, so the post-deploy manual check is the only thing that actually
confirms the feature works where users will hit it.

---

## WORKED EXAMPLE (ILLUSTRATIVE — DO NOT IMPLEMENT)

A plausible small feature: a per-video **"featured" pin** — an admin marks a video as
featured; the homepage shows a small badge on it. This section shows the gates being
answered on paper, against the real files, for calibration. It does not design the feature
completely, and none of this was implemented while writing this skill.

**Phase 0 done-criteria:** "An admin can mark a video as featured from the Videos tab; a
featured video shows a small badge on its card on the homepage." Smoke: (1) as admin, open
`/admin`, Videos tab, click "Feature" on a video; (2) as an approved viewer, load `/`,
confirm the badge appears on that video's card; (3) unfeature it, confirm the badge is
gone. No new dependency, no new env var — no Phase 0.2 detours needed.

**Phase 2 design answers:**
1. Access tier: `requireAdmin` for the write (set/unset featured); the read side isn't a
   new endpoint — it rides along on the existing homepage SSR fetch in `pages/index.js`,
   which is already gated the way the homepage already is.
2. New data: one Redis set, key `k("featured")` → `fablevideo:featured`, via `sadd`/`srem`/
   `smembers` in `lib/store.js`. No TTL — persists until an admin unfeatures it, same
   permanence model as `k("viewers")` and `k("order")`.
3. Bunny mutation: none — this never calls bunny.net's video CRUD, so
   `invalidateVideoListCache()` is not applicable. Worth stating explicitly in the PR per
   Phase 2 question 3 ("skip this, and here's why") so a reviewer doesn't have to guess.
4. Rate limit: no. It's a cheap, admin-only Redis toggle with no external paid API call
   and no email — doesn't meet the "expensive or abusable" bar that justifies
   `allowRequest` (rule 10's examples are all either paid-API-backed or send email).
5. Admin mutation → `logAction(admin, "video.feature", videoTitle)` /
   `logAction(admin, "video.unfeature", videoTitle)` after the Redis write succeeds.
6. Email: not involved.
7. New env var: none.
8. UI: extends the existing Videos tab in `pages/admin.js` (a "★" toggle button per row)
   and the existing homepage video-card render in `pages/index.js` — Pages Router only,
   no new page.
9. Identity: n/a — this feature has no per-user identity comparison of its own; it rides
   on the existing `requireAdmin` check.

**Design alternatives (one paragraph):** Option A — extend `lib/store.js` with
`getFeatured()`/`setFeatured(id, on)` backed by a Redis set, merged into the video list at
read time. Option B — store a `featured: boolean` field directly on each bunny.net video
via a custom metadata field, avoiding Redis entirely. Chosen: **Option A** — bunny.net's
API is the video *source of truth* (title, playback, thumbnails) and this repo's pattern
(load-bearing decision in `architecture-contract` section 2) is that day-to-day
admin-editable state that isn't intrinsic to the video file lives in Redis via
`lib/store.js`, exactly like viewer approval and custom ordering already do — Option B
would mean a second, redundant "is this admin data" pathway outside that pattern for no
benefit.

**File-touch list (real files, paper only):**
- `lib/store.js` — add `getFeatured()` (returns `Set`/array of video IDs) and
  `setFeatured(id, on)` (sadd/srem on `k("featured")`).
- `lib/videoList.js` — a small **pure** helper, e.g. `markFeatured(videos, featuredIds)`,
  so it's independently testable in `lib/__tests__/` without mocking Redis (mirrors how
  `applyOrder` in `lib/__tests__/order.test.js` is tested as pure logic separate from the
  Redis-backed `getOrder`/`saveOrder`).
- `pages/api/admin/featured.js` (new route) — `requireAdmin`, POST to feature, DELETE to
  unfeature, `logAction` after each, following Skeleton A above.
- `pages/index.js` — in `getServerSideProps`, after the existing `fetchVideoLibrary()`
  call, fetch `getFeatured()` and merge via `markFeatured()`; render the badge on cards
  where `video.featured` is true.
- `pages/admin.js` — in the Videos tab section (function around line 248 in the current
  file), add a "★" button per row calling the new route.
- `lib/__tests__/videoList.test.js` (new) — tests for `markFeatured`: marks the right
  videos, handles an empty featured set, ignores IDs that don't match any video. Say, 3
  tests.

**Phase 4 computed totals (paper):** before 4 files/24 tests; added 1 file, 3 tests; after
**5 files / 27 tests** — this is what the agent would state and then verify `npm test`
actually prints.

**Phase 5 docs:** `domain-reference` gets a new row for `fablevideo:featured`;
`change-control`'s Gate 2 counts get updated to 5/27; README gets a one-line mention if it
documents admin capabilities exhaustively (check before assuming).

This is the shape every real feature should take through this skill — the point isn't that
this particular pin feature is a good idea, it's that every Phase 2 question got a
concrete, file-grounded answer instead of being skipped.

---

## Provenance and maintenance

Written 2026-07-13 by reading `change-control/SKILL.md`, `architecture-contract/SKILL.md`,
and directly re-reading `pages/api/admin/viewers.js`, `pages/api/admin/share.js`,
`lib/store.js`, `lib/guard.js`, `lib/redis.js`, `lib/ratelimit.js`, `lib/audit.js`,
`lib/email.js`, `lib/auth.js`, `lib/bunny.js` (lines 1-55, mutation call sites),
`lib/__tests__/order.test.js`, `.github/workflows/ci.yml`, and `package.json` in this repo.
`git status --porcelain` at write-time showed only `?? .claude/` (this skill library being
authored) on branch `claude/skill-library`. Facts below are volatile; re-verify before
relying on them, and treat the sibling skills (`validation-and-qa`,
`environment-and-config`, `domain-reference`, `docs-and-writing`, `run-and-operate`) as the
source of truth for their own content once they exist — this file only forwards to them.

| Volatile claim | Re-verify with |
|---|---|
| Lint/test baseline (4 files, 24 tests, banner-only lint) | `npm run lint; echo $?` and `npm test 2>&1 \| grep -E "Test Files\|Tests"` |
| Build passes with the CI dummy-env one-liner | `sed -n '33,46p' .github/workflows/ci.yml`, then run the one-liner from `change-control` |
| `viewers.js`/`share.js` route skeleton shape (guard-first, per-method branch, labeled `console.error`+502, `logAction`, `Allow` header fallback) | `cat pages/api/admin/viewers.js pages/api/admin/share.js` |
| `store.js` function shape (`k()`+`redis()`, no cache layer) | `cat lib/store.js` |
| bunny mutation → cache-invalidation call sites (currently 3) | `grep -n invalidateVideoListCache lib/bunny.js` |
| Rate-limit precedent budget (`share`, 30/1h) | `grep -n allowRequest pages/api/admin/share.js` |
| No `app/` directory exists | `ls /home/user/fable-video \| grep -x app` (expect no output) |
| All 11 `/api/admin/*` routes call `requireAdmin` | `grep -L requireAdmin pages/api/admin/*.js` (expect no output) |
| ESLint still pinned `^9.x` | `grep '"eslint"' package.json` |
| No lockfile tracked | `git ls-files \| grep -iE 'package-lock\|yarn.lock\|pnpm-lock'` (expect no output) |
| Sibling skill files exist and match what this file forwards to | `ls .claude/skills/*/SKILL.md` |
