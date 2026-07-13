---
name: security-response
description: SOP for triaging and resolving CodeQL alerts, Dependabot alerts, and suspected secret leaks on the Marine Video Portal repo, and the security-invariant checks to run before merging any change touching auth, tokens, or shares. Load when a security alert appears (GitHub Security tab, PR check, CodeQL, Dependabot), a dependency CVE lands, a secret may have leaked or been committed, or a diff touches lib/bunny.js token signing, lib/shares.js, lib/guard.js, lib/auth.js, proxy.js, or pages/watch/[shareId].js. The owner has named security findings as the failure class that matters most for this repo — treat every alert as real until proven otherwise.
---

# Security response — Marine Video Portal

This repo (v1.6.0, private invite-only video portal, first release 2026-07-07) has had
four CodeQL alerts in its history: one real (fixed), three false positives (open, with a
recorded disposition below). This skill is the SOP for handling the next one, plus the
Dependabot process and the secret-leak runbook. It exists because the owner named security
findings as the top failure class — do not let an alert sit untriaged, and do not dismiss
one without a written, checkable justification.

## When NOT to use this skill

| You are trying to... | Use instead |
|---|---|
| Figure out which gates a change needs and the PR flow | `change-control` |
| Understand *why* the architecture is shaped this way (tokenized playback, fail-open/fail-closed) | `architecture-contract` |
| Bump a dependency version (not a Dependabot alert — just staying current) | `dependency-currency` |
| Debug a runtime failure that isn't a security finding (500s, login loops) | `debugging-playbook` |
| Understand a past incident's full story | `failure-archaeology` |
| Look up bunny.net/Auth0/Upstash/Resend API specifics | `domain-reference` |
| Add or change an environment variable (not rotate a leaked one) | `environment-and-config` |
| Deploy, redeploy, or roll back | `run-and-operate` |
| Write or extend tests | `validation-and-qa` |
| Write the alert dismissal comment's prose polish, README/CHANGELOG updates | `docs-and-writing` (this skill supplies the justification text; docs-and-writing is only for wordsmithing elsewhere) |

Use **this** skill the moment a security alert, CVE, or suspected leak appears, or before
touching any file in the "security-touching" class from `change-control` section 1.

## 1. CodeQL triage SOP

Follow these steps in order for every new CodeQL alert (GitHub → repo → Security tab →
Code scanning alerts).

1. **Read the alert.** Note the rule name (e.g. "Use of password hash with insufficient
   computational effort"), severity, file, and line number GitHub gives you.
2. **Locate the flagged code by grepping, not by trusting the line number.** Line numbers
   drift with every commit that touches the file above the flagged line. Find the
   surrounding function first:
   ```bash
   grep -n "^export function\|^export async function\|^function" lib/bunny.js
   ```
   then re-locate the exact flagged construct inside that function (e.g.
   `grep -n "createHash" lib/bunny.js`). Cite the function name alongside whatever line
   number you report — the function name is stable, the line number is not.
3. **Classify real vs. false positive** using the decision table in section 3 below. When
   in doubt, treat it as real — false-positive dismissal requires a specific, checkable
   argument, not a hunch.
4. **REAL finding → fix it via `change-control`.** It is "security-touching" by
   definition, so it needs ALL three gates (lint + test + build) and the full self-review
   checklist there, PR to main, CI green, merge.
5. **FALSE POSITIVE → dismiss in the GitHub UI with a written justification, then record
   the disposition here.**
   - GitHub UI path: **Security tab → Code scanning → click the alert → Dismiss alert →
     reason "False positive" → paste a justification in the comment box.**
   - The justification must name: what the code actually does, why the flagged primitive
     (e.g. SHA-256) is correct for that purpose, and why the "fix" the rule suggests
     (e.g. bcrypt/argon2) does not apply here.
   - Add a row to the standing-dispositions table (section 2) in this file in the same PR
     that dismisses the alert (or a docs-only follow-up), so the next person — human or
     model — doesn't re-litigate it. Route the actual prose edit to `docs-and-writing` if
     you want a polish pass; the facts must come from you, verified against the code.
6. **Never dismiss an alert you have not personally traced into the flagged function.**
   "It's probably fine" is not a disposition.

## 2. Standing dispositions (settled — do not re-litigate)

Verified against the repo on 2026-07-13 (commit `1be60d7`, unchanged from the 2026-07-10
baseline). Re-run the greps below before trusting the line numbers if any time has passed.

| Alert | Rule | File : line (verify with grep below) | Disposition | Evidence |
|---|---|---|---|---|
| #1 | Workflow does not contain permissions | `.github/workflows/ci.yml` | **FIXED** — `permissions: contents: read` added at top of workflow | commit `77bc05a`; verify: `grep -n "permissions:" .github/workflows/ci.yml` |
| #2 | Use of password hash with insufficient computational effort (High) | `lib/bunny.js`, inside `signEmbedUrl` (function starts line 147; `crypto.createHash("sha256")` call is lines 149–152, the `.update(...)` line CodeQL points at is line 151) | **FALSE POSITIVE** — open, dismiss with justification below | verify: `grep -n "createHash\|^export function signEmbedUrl" lib/bunny.js` |
| #3 | Use of password hash with insufficient computational effort (High) | `lib/bunny.js`, inside `signTusUpload` (function starts line 158; `crypto.createHash("sha256")` call is lines 160–163, `.update(...)` at line 162) | **FALSE POSITIVE** — open, dismiss with justification below | verify: `grep -n "createHash\|^export function signTusUpload" lib/bunny.js` |
| #4 | Use of password hash with insufficient computational effort (High) | `lib/bunny.js`, inside `thumbnailUrl` (function starts line 179; `crypto.createHash("sha256")` call is lines 187–190, `.update(...)` at line 189) | **FALSE POSITIVE** — open, dismiss with justification below | verify: `grep -n "createHash\|^export function thumbnailUrl" lib/bunny.js` |

Line numbers for #2–#4 match the original CodeQL-reported lines (151, 162, 189) as of this
verification — they have not drifted since the alerts were raised. If they no longer match
when you check, the file changed; re-locate with the grep commands above before citing.

### Ready-to-paste dismissal justification (alerts #2, #3, #4)

Paste this into the GitHub "Dismiss alert → False positive" comment box, adjusting the
function name/line for whichever of the three you're dismissing:

> This is not a password hash. `<functionName>` in `lib/bunny.js` computes a short-lived
> **request signature** over a high-entropy service secret (`BUNNY_TOKEN_AUTH_KEY` /
> `BUNNY_API_KEY` / `BUNNY_CDN_TOKEN_KEY`, all server-side-only bunny.net account keys),
> not a hash of a user-chosen password. The algorithm — SHA-256 over
> `key + identifiers + expiry timestamp` — is dictated by bunny.net's own embed-token / TUS
> upload / CDN-token signing spec; bunny.net's servers independently recompute and verify
> this exact SHA-256 signature, so this app cannot unilaterally switch to bcrypt/scrypt/
> argon2 without breaking every signed URL bunny.net issues. This application has no
> stored user passwords at all — Auth0 (`@auth0/nextjs-auth0`) owns all authentication and
> password storage; nothing here hashes a credential. The rule's suggested fix (a
> slow, salted password-hashing KDF) is inapplicable to a request-signing use case: slowing
> down every video-embed and thumbnail request by design would be a functional regression,
> not a security improvement, and there is no password to protect. Dismissing as false
> positive.

## 3. Real-vs-false-positive decision table (this codebase)

Every `crypto.*` call site in `lib/`, enumerated (`grep -rn "crypto\." lib/` misses these —
the calls are chained across lines; use `grep -n "createHash\|randomBytes" lib/*.js`):

| Call site | File : function | Purpose | Verdict |
|---|---|---|---|
| `crypto.createHash("sha256")...digest("hex")` | `lib/bunny.js` : `signEmbedUrl` (~147–154) | Sign a time-limited video embed URL per bunny.net's embed-token spec | Not a password hash — false positive (alert #2) |
| `crypto.createHash("sha256")...digest("hex")` | `lib/bunny.js` : `signTusUpload` (~158–171) | Sign a TUS resumable-upload auth header per bunny.net's TUS spec | Not a password hash — false positive (alert #3) |
| `crypto.createHash("sha256")...digest("base64")` (base64url-encoded) | `lib/bunny.js` : `thumbnailUrl` (~179–195) | Sign a CDN thumbnail URL per bunny.net's URL-token spec | Not a password hash — false positive (alert #4) |
| `crypto.randomBytes(16).toString("base64url")` | `lib/shares.js` : `createShare` (line 24) | Generate an unguessable share-link ID (128 bits of entropy, validated on read by `isShareId`'s `^[A-Za-z0-9_-]{16,64}$` pattern, line 13–15) | Correct use of a CSPRNG for an unguessable identifier — not a finding |

**What WOULD be a real finding here** (none currently exist — this is the pattern
recognition list, not an open item):

- Hashing a **user-chosen password** with SHA-256/MD5 anywhere. Does not apply today —
  this app stores zero passwords; Auth0 owns the entire credential lifecycle. If a future
  change ever introduces local credential storage, that hash MUST go through a slow KDF
  (bcrypt/scrypt/argon2), and CodeQL would be right to flag SHA-256 for it.
- A hardcoded secret/API key/token literal in a `.js`/`.ts` file (not `process.env.*`).
  Check: `grep -rnE "(sk_|key-|Bearer )[A-Za-z0-9_-]{20,}" pages/ lib/ components/` should
  return nothing.
- A secret read into a `NEXT_PUBLIC_*` variable, which ships to the browser bundle. Check:
  `grep -rn NEXT_PUBLIC_ pages/ components/ lib/` — as of this verification only
  `NEXT_PUBLIC_SITE_NAME` (`pages/_app.js:31`, `components/AppShell.js:4`) exists, and it
  is a non-secret display string. Any new `NEXT_PUBLIC_*` var carrying a secret is real.
- An `/api/admin/*` route missing the `requireAdmin` guard from `lib/guard.js`. Check:
  `grep -L requireAdmin pages/api/admin/*.js` (expect no output — verified below).
- A share-lookup or error path that reveals the intended recipient's email to the wrong
  logged-in user. `pages/watch/[shareId].js` lines 34–37 deliberately return a generic
  `state: "mismatch"` instead of any detail when `share.email !== email` — any change that
  starts including the recipient's email, name, or share metadata in that branch (or in a
  thrown error, a console log reachable by client, etc.) is a real disclosure finding.
- Flipping either fail-safe direction: `lib/guard.js` line 30 makes viewer approval fail
  **closed** (infra error → 403, no leak); `lib/ratelimit.js` line 27 (the `catch { return
  true; }`) makes rate limiting fail **open** (infra error → request allowed, no lockout).
  A change that swaps either semantic is a real finding even though CodeQL won't catch it —
  catch it in review.

## 4. Dependabot SOP

There is **no `.github/dependabot.yml`** in this repo (verified: `find .github -iname
"*dependabot*"` returns nothing, 2026-07-13). If Dependabot alerts are appearing, they are
GitHub's default repo-level dependency alerts (Settings → Code security), not a configured
schedule — this session cannot query GitHub's alert UI directly, so treat "are there
currently open Dependabot alerts" as **unverifiable from a local checkout**; ask the owner
or check the Security tab.

When an alert lands:

1. **Identify the package and affected version range** from the alert.
2. **Direct or transitive?**
   ```bash
   grep -E '"<package>"' package.json         # direct dependency?
   npm ls <package>                             # shows the resolution chain either way
   ```
3. **Transitive dependency:** this repo intentionally has **no lockfile**
   (`change-control` non-negotiable #4 — `.gitignore` excludes `package-lock.json` etc.).
   That means every fresh `npm install` (local, CI, and Vercel's deploy install) re-resolves
   within each direct dependency's caret range. A transitive CVE fix often arrives
   automatically on the next install/deploy once the maintainer publishes a patched
   version inside the existing range. **Verify, don't assume:**
   ```bash
   rm -rf node_modules && npm install && npm ls <package>
   ```
   If the resolved version already clears the advisory's fixed-version threshold, no code
   change is needed — note it and close the alert. If not (the fix requires a range bump
   the caret can't reach, e.g. a major bump), it becomes a direct-dep-shaped fix: go to
   step 4.
4. **Direct dependency, or a transitive fix that needs a manual bump:** route to
   `dependency-currency` for the actual version-bump work (it owns the latest-versions
   doctrine and the ESLint-9.x pinned exception), then back to `change-control`'s
   "Dependency bump" gate row (fresh `npm install` + all three gates) before merging.
5. Either way, **do not silently ignore** an alert because "no lockfile will probably fix
   it" — run the verification in step 3 and record what you found.

**Candidate improvement (not yet done — flag, don't silently add):** adding
`.github/dependabot.yml` with `npm` and `github-actions` ecosystem entries would give this
repo scheduled version-update PRs instead of relying on default alerts alone. This is a
process change, not a security fix in itself — raise it with the owner rather than adding
it unprompted.

## 5. Secrets: inventory, blast radius, rotation

Every secret-bearing env var, its consumer (verified by grep), what a leak exposes, and
where to rotate it:

| Var | Consumer (verify: `grep -rln "<VAR>" lib/ pages/`) | Blast radius if leaked | Rotate at |
|---|---|---|---|
| `AUTH0_SECRET` | `lib/auth0.js` (via `Auth0Client()`) | Encrypts/signs the session cookie. A leak lets an attacker forge sessions for **any** user, including admins. Rotating it invalidates every current session — **everyone gets logged out.** | Generate a new 32-byte hex value; set in Vercel; redeploy. Warn users of forced logout. |
| `AUTH0_CLIENT_SECRET` | `lib/auth0.js` | Lets a holder impersonate this app to Auth0's token endpoint. | Auth0 Dashboard → Applications → this app → rotate client secret; update Vercel; redeploy. |
| `BUNNY_API_KEY` | `lib/bunny.js` (`apiKey()`, used in the `AccessKey` header for all Stream API calls, and in `signTusUpload`) | Full read/write/delete control of the bunny.net Stream library (upload, delete, replace any video). | bunny.net Dashboard → Stream library → API → regenerate key; update Vercel; redeploy. |
| `BUNNY_TOKEN_AUTH_KEY` | `lib/bunny.js` (`tokenAuthKey()`, used in `signEmbedUrl` and as the fallback for `cdnTokenKey()`) | Lets a holder mint valid embed-playback tokens for **any** video in the library, bypassing the app's own auth entirely — the core "playback is always tokenized" invariant depends on this staying secret. | bunny.net Dashboard → Stream library → Security tab → regenerate Embed View Token Authentication key; update Vercel; redeploy. |
| `BUNNY_CDN_TOKEN_KEY` | `lib/bunny.js` (`cdnTokenKey()`, used in `thumbnailUrl`; falls back to `BUNNY_TOKEN_AUTH_KEY` if unset) | Lets a holder forge valid signed thumbnail/CDN URLs (lower severity than the embed key, but still bypasses "Block Direct URL File Access"). | bunny.net Dashboard → pull zone → Security → regenerate token key; update Vercel; redeploy. |
| `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_TOKEN`, or either with a store-name prefix — see `lib/redis.js` `envBySuffix`) | `lib/redis.js` (`redis()`) | Full read/write access to the entire Redis store: viewer approvals, share records (including recipient emails and video IDs), rate-limit counters, audit log. A leak is a full data-store compromise. | Vercel Storage → the connected Upstash database → regenerate token (or Upstash console directly); update Vercel; redeploy. |
| `RESEND_API_KEY` | `lib/email.js` (`sendEmail`, gated by `emailEnabled()`) | Lets a holder send email as this app's verified sending domain (phishing/spam risk), and read this account's Resend send history. | Resend Dashboard → API Keys → revoke and reissue; update Vercel; redeploy. |

**CI safety note (verified):** `.github/workflows/ci.yml` lines 36–46 use dummy values for
`AUTH0_SECRET`, `AUTH0_CLIENT_SECRET`, `BUNNY_API_KEY`, `BUNNY_TOKEN_AUTH_KEY`,
`KV_REST_API_TOKEN`, etc. — these are placeholder strings for the `npm run build` step
only, never real credentials, and cannot be used against any real Auth0/bunny.net/Upstash
account. Do not treat their presence in the workflow file as a leak.

### Leak-response runbook (any secret above)

1. **Rotate at the provider first** (table above) — this invalidates the leaked value
   immediately, before anything else.
2. **Update the Vercel env var** (Project → Settings → Environment Variables) with the new
   value.
3. **Redeploy** — per `change-control` section 2, env-var changes do not take effect until
   a new deployment; use `run-and-operate` to trigger it. (`AUTH0_SECRET` rotation forces
   every session to re-auth — this is expected, not a bug.)
4. **Audit for misuse** during the exposure window:
   - Vercel → project → Logs, filtered to the exposure window, for unexpected traffic
     patterns.
   - The in-app audit trail: every admin mutation calls `logAction(admin, "noun.verb",
     detail)` (`lib/audit.js`; see `change-control` non-negotiable #11) — check the
     Activity tab in `/admin` for actions the legitimate admins don't recognize.
   - For a Redis-token leak specifically: `listShares()` in `lib/shares.js` and the
     approved-viewer list are both readable/writable by anyone holding the token — check
     for shares or approvals you didn't create.
5. **If the leak was a commit to git** (not just an env-var exposure), the secret is in
   history permanently even after a rotation — rotation is the actual fix; do not rely on
   `git filter-branch`/force-push history rewriting on a shared repo without explicit
   owner sign-off (that's a destructive operation outside this skill's authority).

## 6. Security invariants quick-check (run before merging any auth/share/token change)

Cross-reference: these are the same non-negotiables `change-control` section 3 lists;
this is the greppable verification form. Run all of these against your branch before
opening a security-touching PR.

```bash
# 1. Every admin API route is guarded (expect NO output)
grep -L requireAdmin pages/api/admin/*.js

# 2. No NEXT_PUBLIC_ var carries anything but the two known-safe display values
grep -rn NEXT_PUBLIC_ pages/ components/ lib/
# expect only NEXT_PUBLIC_SITE_NAME and NEXT_PUBLIC_SENTRY_DSN

# 3. No direct bunny CDN file URL introduced (playback must stay token-signed)
grep -rn "b-cdn.net" pages/ components/ lib/ | grep -v "\.md:"
# expect no literal .m3u8 / play_*.mp4 URL construction outside lib/bunny.js's
# own signed-URL builders

# 4. Share mismatch path still reveals nothing about the recipient
grep -n "mismatch" pages/watch/\[shareId\].js
# expect the "state: \"mismatch\"" branch to carry no share/email/video fields

# 5. Fail-open / fail-closed semantics unchanged
grep -n "fails closed" lib/guard.js        # expect the comment still present at ~line 30
grep -n "Fails open" lib/ratelimit.js      # expect the comment still present near the top

# 6. No hardcoded-looking secret literal
grep -rnE "(sk_|Bearer [A-Za-z0-9_-]{20,})" pages/ lib/ components/
# expect no output
```

Verified working on this repo 2026-07-13: check #1 returns no output (all 11 files under
`pages/api/admin/` call `requireAdmin`); check #2 returns exactly the two known lines
(`pages/_app.js:31`, `components/AppShell.js:4`).

## Provenance and maintenance

Written 2026-07-13 against commit `1be60d7` (v1.6.0, 12 commits, same HEAD as the
2026-07-10 baseline — no commits landed in between). All line numbers, function names, and
grep outputs in this file were verified directly against the repo at that commit. GitHub's
live alert/dismissal state (open vs. dismissed, and whether Dependabot's default alerts are
even enabled) was **not** independently verifiable from this session — re-check in the
Security tab before assuming section 2's "open, false positive" status still holds.

| Volatile claim | Re-verify with |
|---|---|
| Alert #1 fix still in place | `grep -n "permissions:" .github/workflows/ci.yml` (expect `contents: read`) |
| Alerts #2–#4 line numbers (151/162/189-ish) | `grep -n "createHash" lib/bunny.js` |
| The three bunny signing functions still named the same | `grep -n "^export function sign\|^export function thumbnailUrl" lib/bunny.js` |
| Share ID generation still 128-bit CSPRNG | `grep -n "randomBytes" lib/shares.js` |
| No dependabot.yml exists | `find .github -iname "*dependabot*"` (expect no output) |
| All admin routes still guarded | `grep -L requireAdmin pages/api/admin/*.js` (expect no output) |
| Only two NEXT_PUBLIC_ vars in use | `grep -rn NEXT_PUBLIC_ pages/ components/ lib/` |
| Fail-closed/fail-open comments still present | `grep -n "fails closed" lib/guard.js; grep -n "Fails open" lib/ratelimit.js` |
| Secret env vars and their consumer files | `grep -rln "<VAR_NAME>" lib/ pages/` per row in section 5 |
| CI still uses only dummy values for the build step | `sed -n '33,47p' .github/workflows/ci.yml` |
| Actual open/dismissed CodeQL alert state on GitHub | GitHub UI: Security tab → Code scanning alerts (not queryable from a local checkout) |
