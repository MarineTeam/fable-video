---
name: docs-and-writing
description: Maintain the Marine Video Portal's documents of record — README.md, FEATURES.md, CHANGELOG.md, and the .claude/skills library itself. Load when documenting a shipped feature, writing release notes, adding an environment-variable row, adding a troubleshooting/common-issues entry, recording a bug fix or security disposition in prose, bumping a version, or updating a skill's "Provenance and maintenance" section after a cited fact changes. Gives the update matrix (change type → exact docs/sections to touch), ready-to-paste templates in each doc's real format, and the style rules this library actually follows.
---

# Docs and writing — Marine Video Portal

This skill answers one question: **when something changes, which files and sections must
change with it, and in what format?** It does not decide whether a change is safe to make
(`change-control`) or why the system is shaped a certain way (`architecture-contract`) —
it only covers writing the record of what happened, in the voice this repo already uses.

Every pattern below is derived from reading README.md, FEATURES.md, and CHANGELOG.md in
full, plus the existing skills, on 2026-07-13. Quoted text is copied verbatim so you can
diff your new prose against it. Re-verify anything you cite — these are living documents.

## When NOT to use this skill

| You are trying to... | Use instead |
|---|---|
| Know which gates/checklist apply before editing a file | `change-control` |
| Understand *why* the architecture is shaped this way | `architecture-contract` |
| Triage a CodeQL/Dependabot alert or write its dismissal justification | `security-response` (this skill only polishes prose once the facts are decided there) |
| Decide whether/how to bump a dependency | `dependency-currency` |
| Diagnose a runtime symptom before you know the root cause | `debugging-playbook` |
| Write up a past incident's full story | `failure-archaeology` |
| Look up bunny.net/Auth0/Upstash/Resend API specifics | `domain-reference` |
| Decide what an env var does or where it's consumed in code | `environment-and-config` |
| Deploy, redeploy, or operate the running app | `run-and-operate` |
| Decide what to test or update test counts in code | `validation-and-qa` |
| Run a diagnostic script | `diagnostics-and-tooling` |
| Plan and sequence a whole feature end to end | `feature-shipping-campaign` |

Use **this** skill once you know *what* changed and need to know *where it must be written
down* and *in what voice*.

---

## 1. The docs of record

| File | Role | When it MUST change | Owner sections |
|---|---|---|---|
| `README.md` (~231 lines) | Setup/operator runbook — how to deploy and run the portal | New/changed env var, new/changed setup step, new admin-panel capability visible to operators, new common failure mode, a security-relevant behavior changes | How it works · Tech stack · Project structure · Environment variables (Required / Optional-email / Optional-other) · One-time setup checklist · Local development · Admin panel · Email delivery · Security notes · Common issues · Scaling notes |
| `FEATURES.md` (~85 lines) | Current-state capability inventory, grouped by area | Any user-visible or admin-visible feature ships, changes materially, or is removed; a known gap closes | The area sections (`## Area name`, `_(admin)_` marker on section or bullet) · Configuration knobs · Known gaps / not yet implemented · the `Current as of **vX.Y.Z**` header |
| `CHANGELOG.md` (~73 lines) | Release history, Keep-a-Changelog-ish | A release cuts (finalize the version section); notable in-flight changes worth recording | The versioned `## [X.Y.Z] - YYYY-MM-DD` sections, their `### Added/Changed/Fixed/Performance/Known gaps` subsections |
| `.claude/skills/**` (13 skills) | The operating manual for every other agent working this repo — a doc of record in its own right | Any fact a skill cites drifts (code moves, a count changes, a commit gets superseded); a new incident, symptom, env var, or test lands | Each skill's own body **and** its `## Provenance and maintenance` section (every skill ends with one — keep it current, don't let it silently go stale) |

The skill library is not exempt from the "keep docs honest" doctrine — a skill with a
stale Provenance table is exactly as misleading as a stale README paragraph, and worse,
because other agents treat skills as ground truth without re-reading the source first.

**Skill-library maintenance duties, spelled out** (route the actual edit to the named
skill's own file — this skill only tells you it's needed):

- New incident (a bug that cost real time to find) → add an entry to `failure-archaeology`.
- New runtime symptom discovered → add a row to `debugging-playbook`'s symptom table.
- New environment variable → add it to `environment-and-config`'s inventory and its
  `references/env.local.template`.
- Test count changes (files or test totals) → update `validation-and-qa`'s inventory AND
  `change-control`'s Gate 2 section (that file states directly: "If your change adds
  tests, these numbers go UP — update this file's counts in the same PR").
- A cited file:line, commit hash, or command output in ANY skill's Provenance table no
  longer matches reality → fix it in that skill, in the same PR as the change that broke it.

---

## 2. The update matrix

Find your change type, touch every listed doc/section. When a change spans rows, take the
union — do not skip a row because another row's edit "covers" it.

| Change type | Docs/sections to touch | Notes |
|---|---|---|
| **New feature (user-visible)** | `FEATURES.md` — new bullet in the matching area section (new `## Area` if none fits) · `CHANGELOG.md` — bullet under the in-progress release's `### Added` · `README.md` — "How it works" and/or "Admin panel" if it changes what a user/admin sees or does | If the release is already shipped/tagged, this becomes a **new** CHANGELOG section instead of editing the shipped one — see the release row |
| **New environment variable** | `README.md` — one table row in whichever of Required / Optional-email / Optional-other fits (see decision rule below) · `environment-and-config`'s inventory and `references/env.local.template` (with a comment matching that file's style) · `.github/workflows/ci.yml`'s build `env:` block **only if** the var is read during `next build` (verify: does removing it make `npm run build` fail, or does the code path only run at request time?) | Which README table: **Required** = app is broken/unusable without it (mirrors the 10 rows currently there); **Optional — email delivery** = only `RESEND_API_KEY`/`EMAIL_FROM`/`EMAIL_REPLY_TO`/`SITE_NAME`-style email knobs; **Optional — other** = everything else optional (thumbnails, Sentry, display name). Verify current table membership with `grep -n '^|' README.md` before adding |
| **Bug fix** | `CHANGELOG.md` — bullet under the in-progress release's `### Fixed` (Keep a Changelog's category; not yet used in this repo's single release, so there's no in-repo example to quote — model it on the `### Added` bullet format below) · `debugging-playbook` — new symptom row if this fixes a previously-undocumented failure mode · `failure-archaeology` — new entry if it cost real debugging time (that skill defines the entry shape; reference it rather than duplicating — see template note below) · a regression-test note per `validation-and-qa`, and update `change-control` Gate 2's counts if the test total changed | Don't skip the archaeology entry because "it was quick to fix" — the bar is time *spent finding it*, not fixing it |
| **Dependency change** | `CHANGELOG.md` — bullet under `### Changed` (or fold into the next `### Added` if it ships alongside a feature) · `dependency-currency`'s watchlist if the bump is notable (a major version, a pin/skip decision, a new exception like the ESLint 9.x pin) | Routine patch/minor bumps within existing caret ranges (the no-lockfile "latest versions" doctrine) usually don't need a CHANGELOG line by themselves unless they fix something user-visible |
| **New admin capability** | `README.md` — "Admin panel (`/admin`)" section, bullet under the relevant tab · `FEATURES.md` — bullet in the matching area, with the `_(admin)_` marker (inline on the bullet if the section is mixed-audience, on the section header if the whole area is admin-only) | This is a subset of "new feature" with a mandatory README Admin-panel touch — don't let the FEATURES-only edit stand alone |
| **Security fix / disposition** | `security-response`'s standing-dispositions table (that skill owns the table structure and the fix/dismiss decision; this skill supplies wordsmithing only if asked) · `CHANGELOG.md` — only for a REAL fix that changes behavior, under `### Fixed` or `### Security`; a false-positive **dismissal** typically stays in `security-response` alone, not the CHANGELOG | Never write the disposition's technical justification yourself from scratch — the facts must come from whoever traced the flagged code, per `security-response`'s own rule ("Never dismiss an alert you have not personally traced") |
| **Release** | `CHANGELOG.md` — finalize the version section (add/confirm the `- YYYY-MM-DD` date) · `FEATURES.md` — bump the `Current as of **vX.Y.Z**` header (line 3) · `package.json` — bump `"version"` | See version-bump convention note below — three releases now confirm the ordering, but v1.8.0 shipped with `package.json` **and** the FEATURES header lagging behind, so verify all three artifacts agree before publishing |

**Version-bump convention (now established across three releases, and already broken once):**
this repo has shipped three releases — `v1.6.0` (2026-07-07, the chosen starting version),
`v1.7.0` (2026-07-14, installable PWA), and `v1.8.0` (2026-07-15, Web Push). The rule is:
**bump `package.json`'s version in the same PR that finalizes the CHANGELOG section, and
bump `FEATURES.md`'s `Current as of` header at the same time.** This is no longer a guess —
but it is easy to forget: **v1.8.0 shipped its tag and CHANGELOG header while `package.json`
still read `1.7.0`** (reconciled later on `main`, 2026-07-15 — see `failure-archaeology`
FA-9 and `run-and-operate` §5), and **`FEATURES.md`'s header lagged at `v1.7.0` after the
v1.8.0 release**. So verify all three artifacts agree before publishing the GitHub Release:
`grep '"version"' package.json`, the top `## [x.y.z]` header in `CHANGELOG.md`, and
`FEATURES.md` line 3 must all name the same version.

---

## 3. Templates (ready to paste)

### CHANGELOG release section skeleton

Quoted structure from the one real release (`CHANGELOG.md` lines 6–69):

```markdown
## [X.Y.Z] - YYYY-MM-DD

<One short paragraph: what this release is, in plain language.>

### Added

- **Area name** — description of the capability, in one to three sentences,
  wrapped at ~78 chars.

### Performance

- Bullet describing a measurable speed/efficiency change and, if known, what
  it replaced.

### Known gaps

- Bullet naming a real limitation, phrased plainly (not defensively).

See [FEATURES.md](FEATURES.md) for the full, current feature list and
[README.md](README.md) for setup instructions.
```

`### Fixed`, `### Changed`, `### Security` are standard Keep a Changelog categories this
repo hasn't used yet (only `Added`/`Performance`/`Known gaps` appear in `[1.6.0]`) — use
them when the content calls for it, matching the same bullet style.

### FEATURES.md bullet

Bold lead-in, em-dash, plain-language description. Quoted example (`FEATURES.md` line 33):

```markdown
- **Upload directly from the browser to bunny.net** — TUS resumable upload
  with a progress bar, **drag-and-drop**, and **cancel/retry** for
  in-progress uploads (a cancelled upload cleans up its half-created video).
```

`_(admin)_` marker convention (quoted, line 3 + line 17): the header states
"items marked _(admin)_ live in the `/admin` panel." It appears two ways —
on a **section header** when the whole area is admin-only (`## Video management _(admin)_`),
and **inline on a bullet** within a mixed-audience section
(`- **Admin-adjustable color palette** _(admin)_ — 7 presets plus custom hex colors...`).
Use the section-level tag only if every bullet under it is admin-only.

### README environment-variable table row

```markdown
| `VARIABLE_NAME` | One sentence: what it is, where it comes from, format if non-obvious. |
```

Quoted example (`README.md` line 109): `` | `AUTH0_SECRET` | Random 32-byte hex string encrypting the session cookie. Generate with `openssl rand -hex 32`. | ``

### README Common-issues row

Bold symptom (as the user would describe it) — em-dash — explanation, then the fix as a
second sentence. Quoted example (`README.md` line 217):

```markdown
- **Thumbnails show as a title list** — `BUNNY_CDN_HOSTNAME` isn't set (or
  the deploy hasn't picked it up). The grid only appears once the API
  returns thumbnail URLs.
```

### failure-archaeology entry skeleton

`failure-archaeology` owns this template — reference it, don't fork it. Quoted verbatim
from `failure-archaeology/SKILL.md` (its own "Template" block, appended as a new `### FA-N`
section before its DELIBERATE ODDITIES, incrementing N):

```markdown
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

The DO-NOT row is mandatory there, not optional — "a story without a DO-NOT is just
changelog trivia" (`failure-archaeology`'s own words). If there's no commit behind the
incident (an operational event, a config change made outside git), that file's convention
is to mark the evidence `[reported]` and say why no diff exists, instead of forcing a fake
`[git-verified]` tag.

### Skill "Provenance and maintenance" line format

Quoted pattern (from `change-control`, `debugging-playbook`, `architecture-contract` — all
three independently converged on this shape):

```markdown
## Provenance and maintenance

Written YYYY-MM-DD against commit `<hash>` (<version/context>). Facts below
are volatile — re-verify before relying on them.

| Volatile claim | Re-verify with |
|---|---|
| <specific claim, e.g. a count or file:line> | `<exact shell command>` |
```

Every row must be a claim that can drift (a count, a line number, a pinned version) paired
with the exact command that re-checks it — not a vague "check the code."

---

## 4. Style guide (derived from the actual docs, not invented)

- **Bold lead-in + em-dash** is the dominant construction across all three docs for any
  enumerable fact — a feature, an env var's optionality, a gap. Example: "**Access is by
  email identity.** Admin, approved-viewer, and share-recipient checks all compare the
  session's email (normalized)." (README, Security notes)
- **Second-person-implied imperative** in setup instructions — numbered steps read as
  commands, not descriptions: "1. **bunny.net** — create a Stream library, enable
  **Embed View Token Authentication** (Security tab), upload videos..." (README, One-time
  setup checklist). "You" appears explicitly too: "You'll need the environment variables
  above in a local `.env.local`..." (README line 169).
- **Tables for anything enumerable**: env vars, tech stack, project structure gets a code
  tree instead (structure is inherently hierarchical, not tabular — follow that judgment
  call, don't force a table where a tree/list reads better).
- **The voice is plain and reassuring about degraded modes, not just feature lists.**
  Quoted exactly: "Without these, everything still works — admins copy share links and
  send them manually." (README line 131, after the optional email env vars). New docs
  should say what happens when a feature *isn't* configured, not just what happens when it is.
- **Honesty markers — Known-gaps discipline.** Both FEATURES.md and CHANGELOG.md end
  substantive sections with a plainly-worded gaps list, e.g. "No self-serve access-request
  flow — admins must know who to add." (CHANGELOG, Known gaps). Never omit a Known-gaps
  section from a new doc that inventories capabilities — the absence of one reads as
  oversell, and oversell is explicitly against this owner's doctrine.
- **Date-stamp volatile facts.** `CHANGELOG.md`'s latest release header is
  `[1.8.0] - 2026-07-15` (three release headers exist: 1.6.0/1.7.0/1.8.0); `FEATURES.md`'s
  header reads `Current as of **vX.Y.Z**` (currently `v1.7.0`, lagging the v1.8.0 release —
  a live example of the version drift this skill warns about); every skill's Provenance
  section opens "Written YYYY-MM-DD against commit `<hash>`." Any claim that can go stale
  (a version, a count, "current" anything) gets a date next to it.
- **"Verify with" commands, always runnable, always in skills.** Every volatile claim in
  every existing skill pairs with an exact shell command, e.g. `grep -L requireAdmin
  pages/api/admin/*.js` (expect no output). Docs-of-record prose (README/FEATURES/CHANGELOG)
  doesn't carry inline verify-commands — that convention is skill-specific, not doc-of-record
  wide. Don't add "verify with" clutter to README/FEATURES/CHANGELOG prose; do add it to
  any skill file.

---

## 5. Writing rules for this library's audience (zero-context, lower-class models)

The owner's doctrine: readers are AI models with no memory of this conversation and no
inference budget to fill gaps. Every sentence you write here is instructions to a stranger
who will act on it literally.

- **Every claim must be checkable by a stated command.** Not "the tests pass" — `npm test`
  with the expected tail output shown. Not "all admin routes are guarded" — `grep -L
  requireAdmin pages/api/admin/*.js` with "expect no output" stated.
- **No unresolved pronouns.** If a sentence needs "it"/"this"/"that" to refer more than one
  clause back, restate the noun instead. A reader with no working memory across sentences
  will resolve the pronoun wrong.
- **Define terms at first use, in the same document.** `change-control` defines "Gate" and
  "Non-negotiable" in its second paragraph before using either term again — follow that
  pattern for any term this doc introduces (e.g., don't say "doc of record" without the
  table in section 1 defining what qualifies).
- **State the expected output after every command**, not just the command. "Run `npm run
  lint`" is incomplete; "Run `npm run lint` — expect exit 0 and only the script banner, no
  other output" is complete and lets a reader detect failure without judgment.
- **Never bury the imperative.** Lead sentences with the action verb ("Add a row to...",
  "Bump the header...", not "It might be worth considering adding..."). This is a runbook
  library, not a discussion — hedged phrasing reads as optional to a model looking for the
  next step, and it will skip it.

---

## Provenance and maintenance

Written 2026-07-13 by reading `README.md`, `FEATURES.md`, and `CHANGELOG.md` in full at
the repo root, plus `change-control/SKILL.md`, `debugging-playbook/SKILL.md`, and
`architecture-contract/SKILL.md` for cross-reference consistency, and
`environment-and-config/references/env.local.template`. `failure-archaeology`,
`validation-and-qa`, `dependency-currency`, and `domain-reference` had no `SKILL.md` yet at
the start of this authoring session (empty directories) but were written by parallel
agents before this file was finished; section 3's failure-archaeology template and the
test-count claim below were corrected against their final, real content before this file
was saved. If any other sibling skill referenced above changes shape later, re-read it and
correct any mismatch here.

**Updated 2026-07-15:** refreshed everything premised on "only one release exists" — the
repo has now shipped v1.6.0/v1.7.0/v1.8.0, so the version-bump convention is established
(§2 Release row, the version-bump note, and the date-stamp style rule). Recorded the v1.8.0
release-drift lessons (`package.json` and the `FEATURES.md` header both lagged the tag) and
README's new fourth env-var section. `FEATURES.md`'s header still reads `Current as of
**v1.7.0**` as of this update — a real, still-open doc-of-record drift, not a skill error.

| Volatile claim | Re-verify with |
|---|---|
| README is ~231 lines, this section structure | `wc -l README.md`; `grep -n '^##' README.md` |
| FEATURES.md `Current as of` header (reads `v1.7.0` — lags the v1.8.0 release) | `sed -n '1,3p' FEATURES.md`; `wc -l FEATURES.md` |
| CHANGELOG.md has three releases (1.6.0/1.7.0/1.8.0); categories used are Added/Performance/Known gaps only | `wc -l CHANGELOG.md`; `grep -n '^###' CHANGELOG.md` |
| Three releases exist (version-bump convention established but missed once at v1.8.0) | `grep -n '^## \[' CHANGELOG.md` (expect `[Unreleased]` + three version headers) |
| `package.json` version matches the CHANGELOG's latest header | `grep '"version"' package.json`; `grep -n '^## \[' CHANGELOG.md \| head -1` |
| Which skills have a written `SKILL.md` vs. an empty directory | `for d in .claude/skills/*/; do [ -f "$d/SKILL.md" ] && echo "$d: written" || echo "$d: EMPTY"; done` |
| `change-control` still instructs bumping its own Gate 2 counts when tests change | `grep -n "these numbers go UP" .claude/skills/change-control/SKILL.md` |
| `security-response` still owns the standing-dispositions table structure | `grep -n "Standing dispositions" .claude/skills/security-response/SKILL.md` |
| Env-var table membership (Required / Optional-email / Optional-push / Optional-other — a push-notifications section was added for v1.8.0) | `grep -n '^###' README.md`; `sed -n '103,152p' README.md` |
| CI build env block (for the "does this var need a ci.yml dummy" test) | `sed -n '16,46p' .github/workflows/ci.yml` |

Resolved since first writing (2026-07-15): two more releases shipped (v1.7.0, v1.8.0), so the
"bump `package.json` in the same PR as the CHANGELOG" pattern is now the established
convention — though v1.8.0 proved it's easy to miss (both `package.json` and the FEATURES
header lagged and had to be reconciled after the tag; see the version-bump note above and
`failure-archaeology` FA-9). And `README.md` did grow a fourth env-var category ("Optional —
push notifications") for v1.8.0's VAPID keys, so the three-table assumption is superseded.
