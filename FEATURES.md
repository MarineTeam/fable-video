# Features

A catalog of what the Marine Video Portal does, current as of **v1.14.0**.
Grouped by audience; items marked _(admin)_ live in the `/admin` panel. For
setup and architecture, see [README.md](./README.md).

---

## For viewers

### Sign-in and access control
- **Login required** for every page via Auth0 (`@auth0/nextjs-auth0` v4, routes
  at `/auth/*`).
- **Four-tier access model:** anonymous → signed-in-but-unapproved → approved
  viewer → admin. Unapproved users get a clear "not approved" message and never
  receive any video data. Approval **fails closed** — an infra error denies
  access rather than leaking content.
- **Server-side admin gate** — `/admin` checks the session and admin email in
  `getServerSideProps` and redirects non-admins before any UI is sent; every
  `/api/admin/*` route also independently returns `403`.
- **Idle timeout** — an open portal signs itself out after 30 minutes of
  inactivity, protecting sessions left open on shared machines.
- **Rolling sessions** — the session refreshes on ordinary page/API traffic so
  active users aren't logged out mid-session.
- **API rate limiting** (sliding window) on the video list, upload, share, and
  broadcast endpoints; fails open so an infrastructure hiccup never blocks real
  users.
- Centralized identity logic in one shared helper (`lib/auth.js`). Auth0
  sign-ups can be disabled tenant-wide so strangers can't self-register.
- **Geo-location whitelist** _(optional)_ — two country lists, each an env
  var (`GEO_WHITELIST`, `ADMIN_GEO_WHITELIST`) so they're always editable
  directly in Vercel, each with its own enforcement toggle in the Settings
  tab (off by default). `GEO_WHITELIST` restricts the whole site, including
  login; `ADMIN_GEO_WHITELIST` is a bypass list so an admin traveling
  somewhere the main whitelist doesn't cover isn't locked out. Enforced at
  the network boundary (`proxy.js`) via Vercel's request geolocation, before
  login even loads. A blocked visitor sees a generic "not available in
  your region" page; both lists show read-only in the Settings tab.
- **Admin geo bypass by email** _(optional)_ — `ADMIN_GEO_BYPASS_EMAILS`,
  a third env-var list: a signed-in visitor whose email is on it always
  gets through, regardless of country and with no enforcement toggle to
  flip. Meant to be armed before traveling as a standing safety net,
  since `ADMIN_GEO_WHITELIST` requires knowing the destination country
  ahead of time and env var changes only take effect on redeploy.

### Browsing the library
- **Modern dark design** — glassmorphism, gradient accents, Inter typography.
- **Admin-adjustable color palette** _(admin)_ — 7 presets plus custom hex
  colors, applied to **all** visitors; cached client-side with a no-flash
  pre-paint script so returning visitors never see a color flicker.
- **Thumbnail grid** — a responsive grid of 16:9 cards with duration badges and
  a play overlay when thumbnails are configured; falls back to a clean **title
  list** otherwise. Thumbnail URLs are **CDN token-signed** so they work with
  "Block Direct URL File Access" enabled.
- **Instant search** — the whole (admin-capped) library loads once, then search
  runs client-side against it (debounced) — no round trip per keystroke. It
  matches **sermon notes as well as titles**, so a passage or speaker that was
  never in the title is still findable months later. Searching only ever
  narrows the list the server already decided this viewer may see.
- **Collection filters** — narrow the library to a single collection via chips;
  filtering is instant and client-side.
- **Pagination** — 10 per page with Previous/Next, reset to page one whenever the
  search or collection filter changes.
- **Server-rendered first paint** — the library is fetched on the server and
  embedded in the initial HTML, so content appears without waiting for hydration
  plus a second fetch.
- **Admin-adjustable video count** _(admin)_ — hard cap enforced in code
  (bunny.net's API doesn't honor it as a strict limit).
- **Custom ordering** _(admin)_ — drag-to-reorder; newly uploaded videos float to
  the top (newest first) until placed.

### Watching
- **Tokenized playback** — every play uses a fresh, signed, time-limited
  bunny.net embed token generated per request, never a permanent or public URL.
  Autoplay is disabled on all embedded players.
- **Resume where you left off** — the player remembers each viewer's position per
  video (via player.js); reopening seeks back to the saved spot. Progress is
  saved on pause, on end, and periodically during playback. Degrades gracefully
  if the player protocol is unavailable — plain playback still works.
- **Chapters** — a video can carry a list of timestamped chapters ("Worship
  0:00 · Announcements 18:30 · Sermon 24:15 · Communion 1:11:00"), shown under
  the player; clicking one seeks straight to it. Aimed at 60–90 minute service
  recordings, where scrubbing blind is the whole problem. If the player
  protocol is unavailable the list still renders, as plain non-clickable text
  rather than buttons that would do nothing.
- **Sermon notes** — free text under the player: an outline, the passage
  covered, who spoke. Rendered as plain text with line breaks preserved
  (never as markup), and searchable from the library.
- **My list** — save a video to come back to. A toggle beside the title on the
  watch page, and a "My list" row at the top of the library, newest saved
  first. Distinct from continue-watching, and deliberately shown above it:
  this is what you **chose**, that is what you happened to **start**. A saved
  video you never opened appears here and nowhere else. Saving respects group
  access both ways — you cannot save a video you are not allowed to see, and a
  video that later leaves your access simply drops out of the row rather than
  sitting there unopenable. Capped at 200, which refuses politely rather than
  dropping the oldest silently.
- **Rate a video** — 👍 or 👎 beside the title on the watch page. Pressing the
  vote you already hold clears it, which is the only way to take one back.
  **A viewer sees their own vote and nobody else's** — the totals go to staff,
  on the admin Videos tab, and never to viewers. In a library watched by a few
  dozen people a visible "2 down" on someone's teaching is a social problem
  the product does not need, and at that size a public counter is close to
  attributable anyway. The vote is stored under the viewer's own key; the
  totals are plain integers holding no address at all, and **the vote and its
  total are written together in one Redis step**, so they cannot disagree. A
  **Recount ratings** button on the admin Videos tab rebuilds every total from
  the votes, for totals written before that was true. Rating obeys group access and the
  publish window the same way saving does, and answers 404 rather than 403 for a video out of scope, so it
  cannot be used to find out which ids exist.
- **Transcript** — the spoken text of a recording, under the player, collapsed
  by default. Every line carries the timestamp it was said at and clicking one
  seeks there, like a chapter but at the resolution of a sentence. A search box
  inside the panel filters to the lines that mention a word, and the library
  search above matches videos by **what was said in them**, not just their
  title and notes — so a half-remembered phrase finds the sermon that contains
  it. Transcription is bunny.net's, produced from the audio; a video that has
  not been transcribed shows no panel at all. **Every language bunny produced
  is kept**, with a picker in the panel when there is more than one —
  translation is billed per language, so ingesting only one would mean paying
  for tracks nobody could read. A language the video does not have is reported
  rather than quietly answered with another, because a viewer who picks
  Spanish and reads English concludes the translation is wrong rather than
  absent. **One click, not two**:
  transcription is asynchronous, so queueing records the video, and both the
  admin Videos tab and a **scheduled job** collect whatever bunny has finished
  since — so a transcript no longer waits for an admin to come back — and the
  *Fetch captions* button still works for anyone who wants it now. The job is
  inert until `CRON_SECRET` is set (see Configuration); it runs daily, which
  every Vercel plan allows, and can run every 15 minutes on Pro. Before this, forgetting the second click left a video that had really
  been transcribed and paid for, with no transcript and nothing saying why. Degrades the way chapters do: no
  player protocol means plain text instead of buttons that would do nothing.
- **Search reaches the whole library** — typing in the search box matches the
  loaded page instantly in the browser, as it always has, and the server
  searches **everything else the viewer is allowed to see** at the same time,
  merging the two in library order. Before this, a video past the admin's
  homepage count could not be found by searching for it: the library had it,
  the search could not reach it. Matches on title, notes and what was said.
  Results are capped at 60 and the cap is **reported** — "showing the first 60
  of 143" — rather than letting the viewer conclude that is all there is. The
  server half is extra reach, not the search itself: if it fails, the instant
  local search still answers.
- **Search finds other forms of a word** — "baptism" finds "baptised",
  "baptized" and "baptizing"; "forgiving" finds "forgiveness"; "praying" finds
  "prayed". Every word of a multi-word search must appear somewhere in the
  title or notes, in any order. It only ever **adds** matches — the plain text
  search is untouched — and it is deliberately cautious: common word endings
  that are also ordinary letters ("-er", "-en") are left alone, so "Peter" never
  finds "pet", and words match whole, never inside a longer word. A search that
  is a Bible passage is answered by the passage alone, so "Philippians 2" never
  widens to the whole book.
- **Search by passage** — searching for a Bible passage finds every video whose
  title or notes cite an **overlapping** passage, however it was written:
  "Philippians 2" finds a talk noted as "Phil 1:27–2:11", and "Philippians"
  finds "Php 4:13". Book names, common abbreviations, numbered books ("1 Cor",
  "First John", "II Tim"), ranges across chapters and verse lists ("Romans
  8:28, 31–39") are all read. It only ever **adds** matches — anything the plain
  text search found is still found. On the watch page, the passages a video
  cites appear as links that open the library searched for that passage.
  **Browse by book** on the homepage (collapsed by default) lists every book
  the viewer's library cites, with how many videos cite it, in Bible order;
  clicking one searches that book. The list is built over the same scoped
  library as search — a count is itself information, so a video a viewer may
  not see never adds to one.
  Deliberately cautious about inventing references: a book name needs a
  chapter number and a capital letter, the chapter must exist in that book
  ("Mark 20" is not a passage), and two-letter abbreviations that are ordinary
  words ("Is", "Am") are not read at all. An abbreviation typed on its own is
  not treated as a book — "phil" is more likely a person than Philippians.
- **Link to a moment** — a *Copy link at 24:15* button under the player copies
  the page address with the current position on it, and opening a link with
  `?t=` starts there. An explicit timestamp **beats the saved resume
  position**: the viewer followed a link to a point, and sending them to where
  they last stopped instead would quietly ignore what they clicked. A value
  that is not a timestamp is ignored rather than treated as 0:00, so a mangled
  link leaves resume alone instead of dropping them at the start. Reads plain
  seconds, `1:30`, `1:02:03` and `1h2m3s`, because people hand-edit these.
- **Continue-watching** — the homepage shows a strip of in-progress videos with
  progress bars, newest first. Finished and barely-started videos are excluded.
- **My activity** — a full watch-history page (`/activity`, linked from the
  nav) listing every video the viewer has progressed on, finished or not,
  most-recent first, with a resume/rewatch link and progress bar. Admins
  additionally get a **"View as"** dropdown, populated from the approved
  viewers list, to look up any approved viewer's watch history the same
  way.

### Listening in a podcast app
- **Private per-subscriber feed** — each viewer gets their own feed address
  (from **My activity**) to paste into any podcast app, so a service can be
  listened to while driving or walking. The address carries a 256-bit random
  token that identifies **the account and nothing else**: approval, group
  restrictions and publish windows are all re-checked on every poll and every
  download. Losing access ends the feed on the next poll — there is nothing
  to revoke, because the address never granted anything. A **Regenerate**
  button replaces the address if it is ever shared by mistake.
- Episodes are **video MP4s**, not audio: bunny.net has no audio-only format.
  They play in podcast apps but download far more data than audio would.
- **Each episode shows its own thumbnail** as artwork in the podcast app,
  rather than the site icon on every episode. The app is given a stable
  address on this portal, re-checked like the episode itself on every fetch,
  so artwork disappears with access and no expiring bunny.net link ends up in
  the app's cache.
- Off until an admin enables it, and every denial looks identical from
  outside — a wrong or retired address is indistinguishable from one
  belonging to someone who is no longer approved.

### Notifications & installable app
- **Change the app icon from the admin page** _(admin, Settings)_ — choose any
  image and it becomes the home-screen icon for new installs, the iOS icon and
  the podcast cover, with no redeploy. It is cropped to a square from the
  centre and resized in the browser; the server re-checks every size is a PNG
  of exactly that size before storing it — never an SVG, which could carry
  script. **Reset to default** brings the built-in icon back. Already-installed
  apps pick it up when their browser next re-checks the manifest.
- **Push notifications** — approved viewers can opt in with a "Notify me" button
  and get a Web Push notification when a **new video becomes ready** (announced
  once per video, first run seeded silently). Sends only ever reach
  currently-approved viewers/admins, and dead subscriptions are pruned
  automatically. Inert until VAPID keys are configured; on iOS, push requires the
  PWA be installed to the Home Screen first (iOS 16.4+).
- **Installable (PWA)** — a web app manifest, app icons (standard + maskable), and
  Apple touch-icon/meta let visitors install the portal and launch it standalone.
  The manifest's name/short_name and the iOS home-screen title both follow the
  admin-set site name live (generated per-request, not a build-time file), so a
  fresh install always picks up a rename; an already-installed app follows
  whatever schedule the OS/browser uses to re-check an installed PWA's
  manifest, which the app doesn't control. A deliberately minimal service
  worker caches only the static app icons and the (now server-generated but
  still public/non-secret) manifest — never Auth0, `/api/*` responses, or
  signed video/thumbnail URLs.

---

## Private share links (per-recipient sharing) _(admin)_

- Generate one-off private links for any video, tied to specific recipient
  emails — the same video's Share button accepts multiple comma/space/
  newline-separated addresses or a tagged viewer group, not just one, and
  creates one independently-revocable link per recipient in a single action.
- **Automatic email delivery** — when email is configured (Resend), the recipient
  gets a branded email with the video title, a watch button, the exact expiry,
  and a note that the link only works for their address. Optional per-link
  (checkbox at creation).
- **Send / resend from the Shares tab** — one click emails an existing link (for
  links created before email was configured, failed sends, or lost emails). Each
  link shows an **Emailed** badge with the delivery time.
- **Failure-safe** — if an email send fails, the link is never lost: the admin
  sees the error, can copy the link manually, and can retry later.
- **Forced login** — opening the link requires an Auth0 login and only plays if
  the logged-in email matches the one specified. Wrong-account attempts show a
  generic mismatch message — **the intended recipient's email is never revealed**.
- **Adjustable expiry** per link (default 72 hours, capped at 720 / 30 days).
- **Bulk sharing** — select multiple videos in the Videos tab and share all of
  them with multiple recipients in one request. Every video × recipient pair
  gets its own independently-revocable link (up to 200 pairs per request), and
  each recipient gets exactly **one** email listing only their own links —
  never anyone else's.
- **View tracking** — each link tracks how many times its watch page was
  opened and when it was last opened, not just a single "viewed" stamp.
- **Real-playback tracking** — separately from page views, the Bunny player's
  own events (play, timeupdate, ended) report actual playback per link: how
  many times playback started, the furthest percentage watched, and whether
  it was watched to completion. This distinguishes someone who opened the
  link from someone who actually watched.
- **Instant, recoverable revocation** — kill any active link immediately, one
  click, or select several and **bulk revoke** them in one action (each link
  revoked independently, per-link success/failure result). Revoking is a
  soft flag, not a delete — a revoked link shows a **Revoked** badge in the
  Shares tab with **Restore** (undo the revoke, same id/URL, no
  re-notification) and **Delete permanently** (irreversible) actions.
- Expired/revoked links show a clean "expired or doesn't exist" message.
- **Unguessable IDs** — share IDs are random 16-byte tokens, format-validated
  before any lookup.
- **Extend expiry in place** — push a link's expiry out without changing its
  URL or re-notifying the recipient (the counterpart to Revoke). Works even
  on an already-expired-but-not-revoked link. Bulk extend mirrors bulk
  creation: multi-select, one hours value, per-link success/failure result.
- **Bulk resend** — multi-select links in the Shares tab and resend the
  delivery email for all of them in one action. Each link is resent
  independently with its own success/failure result; selected links that
  share a bundled recipient are grouped so that person gets one email, not
  a duplicate per selected row.
- **One consolidated bundle per recipient** — once someone has 2+ active
  share links (from one bulk action or built up over separate ones), they're
  automatically grouped into a single bundle page listing everything
  currently shared with them, gated the same way as an individual link.
  Revoking, expiring, or extending an individual item is reflected on the
  bundle page instantly — the bundle only ever stores a list of ids, never a
  copy of any item's title or status. A recipient's first share still gets a
  plain single-link email; every later notification (new shares, resends)
  becomes one consolidated email once they're bundled.
- **Durable bundle-link access** — a "Bundle pages" section in the Shares
  tab lists every recipient's bundle with a persistent "Copy bundle link"
  button, so the link isn't only available in the moment a bundle is
  created. The bulk-share creation result also surfaces each new/updated
  bundle's link directly.
- **Email watermark, per link** — a Default / Always / Never selector when
  creating a share link (single or bulk) overrides the video's and the
  global watermark setting for that link. See "Email watermark" under
  People & oversight for the full layered resolution order.
- **Share-row provenance** — each row in the Shares tab shows its created
  timestamp inline, plus "part of a bundle" and/or "via Private list" when
  applicable, so an admin can tell at a glance how a link came to exist
  without opening the bundle or Private list panel.
- **Private list, per video** — a persistent, editable panel (Videos tab →
  "Private list") showing everyone added to that one video's list,
  YouTube/Google-Drive style. Adding an email only creates a share and
  sends the notification for people not already **on that list** — someone
  already on it is left completely untouched (no duplicate link, no
  re-sent email). Removing an email revokes its share immediately; inviting
  that same email again later is a brand-new share, like anywhere else in
  the app. A **"Notify new people by email"** checkbox (on by default) lets
  an admin add someone without emailing them — the share is still fully
  live either way, it's only the notification that's skipped.
  **Strictly scoped to what the list itself created** — a link to the same
  video and person made from the ordinary Share or Bulk share button is a
  separate, independently-revocable share the list never lists, never
  treats as "already added," and never touches when you hit Remove; the two
  paths can't step on each other, at the cost of an admin being able to
  double-grant the same person the same video through both. Every share the
  list does create still participates fully in bundle grouping and
  consolidated email like any other share — if it pushes a recipient over
  2 active shares, it's swept into their one bundle exactly the same way.

---

## Video management _(admin)_

- **Upload directly from the browser to bunny.net** — TUS resumable upload with a
  progress bar, **drag-and-drop**, and **cancel/retry** for in-progress uploads
  (a cancelled upload cleans up its half-created video). The file never passes
  through the app server.
- **Encoding status** — per-video "Processing %" / "Failed" badges,
  auto-refreshing while anything is encoding.
- **Rename** videos inline.
- **Delete** videos (removes from bunny.net and prunes them from the saved order).
- **Drag-to-reorder** and **search/filter** the library.
- **Collections** — create/delete collections and assign each video to one.
  A **"Share collection"** button on each collection selects every video in
  it and opens the same bulk-share dialog used for a manual multi-select —
  no need to check each video off one at a time.
- **Bulk operations** — multi-select videos and **bulk delete** or **move to
  a collection** in one action, mirroring the bulk-share UX. Each video is
  processed independently (one failure never blocks the rest), with a
  per-item success/failure report.
- **Editable site name** — set the portal's name from Settings; it applies to
  every visitor immediately, with no redeploy. It appears in the header, every
  page title (including the share-link and "not approved" pages), and share
  emails. `SITE_NAME` / `NEXT_PUBLIC_SITE_NAME` still work as the starting
  value for a fresh install.
- **Chapters & notes editor** — one dialog per video on the Videos tab. Type
  one chapter per line (`24:15 Sermon`; `M:SS`, `MM:SS` and `H:MM:SS` all
  work) and the server parses, de-duplicates the ordering problem by sorting
  on save, and **reports back which lines it could not read** and which
  timestamps fall past the end of the recording — nothing is dropped
  silently. Notes are a second field in the same dialog. Both are additive: a
  video with neither behaves exactly as it did before they existed.
- **Transcribe** — in the same dialog. bunny.net transcribes the audio and the
  viewer-facing transcript appears under the player. **This one costs money**
  (bunny bills roughly $0.10 per minute of video), and the price is printed on
  the control rather than left to be discovered on an invoice. Two clicks, not
  one, because bunny's transcription is asynchronous: *Transcribe* queues it,
  and *Fetch captions* pulls the result in a few minutes later. Deliberately
  does not let bunny generate titles or descriptions — those are
  admin-authored here, and a transcription job must never rewrite them.
- **Suggest chapters** — optionally, the same transcription job asks bunny to
  propose chapters (no extra charge; it is a tick-box on the transcribe
  control, off by default). The proposal is only ever a proposal: *Suggest
  chapters* loads it **into the chapters box** for the admin to edit and save,
  and replacing text already typed there asks first. Nothing about
  transcription writes to the stored chapter list — the AI proposes and a
  person accepts, through the same save a hand-typed list goes through.
- **Public link** _(admin only)_ — makes **one** video watchable by anyone
  with the address, with no account and no sign-in, on its own separate page.
  Everything else stays private: that page shows one video and reveals
  nothing about the rest of the library — no search, no collections, no
  counts, no way in — and asks search engines not to index it. A public video
  still obeys its publish/expiry window and still plays through a fresh
  signed, time-limited token; what it does *not* get is a watermark, a resume
  position, a last-seen stamp or a push subscription, since all of those are
  keyed to an email address and an anonymous visitor has none. The flag
  defaults to off and **fails closed**: if Redis can't be read, the link
  404s rather than risk publishing. Managers see a **Public** badge on the
  row but cannot change it — publishing is a site-policy decision, so it
  needs `settings.manage`.
- **Scheduled publish / expiry** — a per-video window (publish-at and/or
  expires-at, either optional) controlling when **viewers** can see it.
  Outside its window a video disappears from the library, search,
  continue-watching and collection chips, and its watch page returns 404
  before any playback token is minted — a bookmark from before it expired
  won't play. Admins and managers always see it, badged **Scheduled** or
  **Expired**, so it can still be found and previewed. A video with no
  schedule is unconstrained, exactly as before.
- **Per-video watermark override** — a Default / Always / Never select per
  video overrides the global watermark setting for every share of that
  video (unless a per-share or exemption override applies — see "Email
  watermark" below).
- **Per-video share analytics, inline** — a "Stats" toggle per video row
  expands the same share-link rollup shown in the Analytics tab (link
  count, unique recipients, views, started/completed, avg progress) without
  leaving the Videos tab.

---

## People & oversight _(admin)_

- **Approved viewer management** — add/remove emails, with **bulk add** (paste
  comma/space/newline-separated lists; validated + deduped, with invalid entries
  reported back).
- **Self-serve access requests** — someone who signs in but isn't approved
  sees a **Request access** button with an optional short note, instead of a
  dead end. Requests land in a queue at the top of the Viewers tab where an
  admin can **Approve** (adds them as a viewer and clears the request),
  **Deny** (keeps the record so they don't reappear in the queue), or
  **Dismiss** a denial to let them ask again. The request records who asked
  and what they said, and grants nothing on its own: the address comes from
  the session rather than the request body, and it's rate-limited to 5 a day.
- **Access-request notifications** — a new request emails and push-notifies
  the people who can action it (those holding the people-management
  capability, which today is admins and `ADMIN_EMAILS`). Only a genuinely new
  request notifies: re-asking while one is already pending sends nothing, so
  a refresh loop can't become a notification flood. Delivery is best-effort
  and inherits the existing inert-until-configured posture — no Resend key
  means no email, no VAPID keys mean no push, neither means no errors and no
  visible difference — and a delivery failure never fails the request itself.
  The push says only who asked; the requester's note goes in the email, HTML-
  escaped, rather than onto a lock screen. There is deliberately no
  approve-by-link: a link that grants access from an inbox grants it to
  whoever else can read that inbox.
- **Optional verified-email enforcement** — with `REQUIRE_VERIFIED_EMAIL` set,
  a session whose Auth0 `email_verified` claim isn't true is refused
  everywhere, before any approval or role lookup. A missing claim counts as
  unverified. Off by default, and `ADMIN_EMAILS` addresses are exempt so the
  setting can always be undone by the person who turned it on. "Everywhere"
  includes the share and bundle watch pages: recipients are the users least
  likely to hold a verified address, which is exactly why exempting them would
  leave a forged unverified session able to match a link's recipient. They see
  the same "verify your email" notice rather than a login redirect, which would
  loop for someone already signed in.
- **Custom roles** — roles are built by an admin, not fixed. A role is a named
  set drawn from 13 capabilities (view vs. manage vs. upload videos; view vs.
  manage viewers and shares; analytics, audit log, broadcasts, settings,
  groups, roles). A person can hold several and gets the union, and holding any
  capability grants library access on its own. Created and assigned from the
  **Roles** tab with no redeploy.
- **You can only hand out what you hold** — creating, editing, deleting or
  assigning a role is refused if it would grant a capability the actor lacks,
  and equally if it would *strip* one they could not have granted. That is what
  makes it safe to delegate role management to someone who is not an owner.
- **`ADMIN_EMAILS` owners are unconditional** — they hold every capability,
  resolved without reading Redis, and cannot be demoted by any stored data.
  They are the recovery path if the role data is ever lost or corrupted, and
  changing that list still needs an env edit and a redeploy.
- **Invented capabilities grant nothing** — the catalog lives in code, so a
  hand-edited Redis record claiming something outside it is ignored rather
  than honoured.
- **Viewer groups/tags** — tag approved viewers (e.g. "Team A") from the
  Viewers tab, filter the viewer list by tag, and pull a whole tag's emails
  into the bulk-share or Private list recipient box with one click instead
  of pasting each address by hand.
- **Per-group publish windows** _(admin, Schedule on a video)_ — besides the
  video's own publish/expiry window, give a group its **own** window: the
  youth leaders see Sunday's talk from Wednesday, or a class keeps a video a
  month after it expires for everyone else. Group windows only ever **add**
  time — a member sees the video during their group's window OR the default
  one — so they cannot be used to hide a video from a group (group
  restrictions do that), and a group that could not see the video at all
  still cannot. They apply everywhere the default window does: the library,
  search, the watch page, transcripts, continue-watching and the podcast feed.
  Deleting a group removes its windows, so a new group with the same name
  starts with none.
- **Repeating windows** _(admin, Schedule on a video → "Only at set times each
  week")_ — pick days and a time range ("Sundays 09:00–13:00", or Wednesday and
  Sunday evenings) and viewers see the video only inside those slots, still
  within its publish/expiry dates. Times are read in the time zone the rule was
  saved in (shown beside the times), so summer time does not shift the slot. An
  end before the start runs past midnight. It applies everywhere the publish
  window does, including the public page and the podcast feed; staff still see
  the video at all times, and the library badge says "Weekly · on now" or
  "Weekly · off now". Group windows are not limited by it, so leaders can still
  preview outside the slot. It stops new visits; a player already open keeps
  going until its signed link runs out.
- **Group content restrictions** — a group can optionally be **restricted** to
  an explicit list of videos **and/or whole collections** (Groups tab), so its
  members see only those in
  the library, in search, in continue-watching, and on the watch page itself.
  A tag with no group record, or an unrestricted group, stays a plain label
  that grants and restricts nothing — so every tag that existed before this
  shipped behaves exactly as it did. Belonging to several groups means the
  union of the restricted ones; an unrestricted group never widens a
  restricted one, and its collections are ignored for the same reason its
  videos are. **A collection grant auto-follows**: a video uploaded into a
  granted collection is visible to that group on the next request with nobody
  editing anything, which is the answer to ticking every new upload by hand.
  Deleting a collection prunes it from every group that granted it, so a grant
  never names something that no longer exists. **A single upload can be granted
  as it is created**: the upload card lists the groups (for someone holding
  `groups.manage` — uploading alone does not let you grant access), and files
  dropped while groups are ticked are added to them. Nothing is ticked by
  default and there is no stored default group, deliberately. A group that no
  longer exists, or already grants its 500-video maximum, is refused before the
  video is created; a grant that fails afterwards is named on the upload row
  rather than failing the upload. Cancelling an upload clears it from any group
  it was granted to. Managers and admins are never group-scoped. Enforcement is
  server-side throughout: an out-of-scope video 404s before any playback token
  is minted, rather than merely being hidden from a list.
- **Group membership editor** — add or remove people from a group **on the
  Groups tab**, one at a time or by pasting a list, instead of tagging each
  viewer individually. It reports what happened to every address you named:
  added, removed, already as you asked, not an approved viewer, at the 20-tag
  limit, or failed. Tagging never approves anybody — an address that is not
  already on the viewer list is reported, not created. Membership matches
  across spelling ("team a" and "Team A" are one group), so adding someone
  cannot leave them carrying two tags for it and removing them cannot leave a
  variant behind that still restricts what they see. Needs `viewers.read` as
  well as `groups.manage`, since it names people.
- **Viewer last-seen** — each viewer's most recent activity time.
- **Activity / audit log** — the most recent admin actions (viewer
  add/remove/**tag**, **role change**, **group save/delete**, **access
  request/approve/deny**, **video schedule**, share
  create/revoke/**email**, video
  rename/delete/reorder, collection create/delete, settings, palette), each
  with actor and time. Logging is best-effort so it never breaks the
  underlying action.
- **Analytics dashboard** — total views, 30-day views, watch time, video count, a
  30-day views chart, and a most-watched list (from bunny.net video stats + the
  statistics API).
- **Per-video share analytics** — a collapsible panel rolling up existing
  per-share tracking by video: link count, unique recipients, views,
  playback starts, completions and completion rate, and average
  furthest-percent watched. Reads only fields already stored on share
  records — no new tracking is added.
- **Manual push broadcast** — send a notification to every currently approved
  viewer (and admins); click-through targets are restricted to same-origin paths.
- **Content-protection panel** — explains the tokenized-playback model and the bunny.net "Block Direct URL File Access" setting.
- **Email watermark** — overlays the viewer's email and a timestamp on
  playback as a deterrent against re-sharing recordings. Layered,
  most-specific-wins resolution: a per-recipient **exemption** (managed in
  Settings, applies to any viewer or admin email) always wins; then a
  per-share Always/Never choice (set at share creation); then a per-video
  override (Videos tab); otherwise a global on/off default (Settings tab)
  applies. Applies to both private share-link playback and direct
  approved-viewer playback.

## Admin panel structure _(admin)_
- **Tabbed layout** — Videos, Viewers, Shares, Settings, Activity, Analytics — so
  admins jump straight to a section instead of one long scroll. Live count badges
  on Viewers/Shares.
- All admin API routes return `403` for non-admins rather than exposing any data.

---

## Platform, quality & observability

- Hosted on Vercel; dependencies install automatically during deploy (no local
  Node/npm required to ship).
- Next.js 16 (Pages Router) + React 19; Auth0 session handling runs in the Next
  16 `proxy.js` network boundary.
- Settings, viewers, order, collections, share records, watch history, and the
  audit log are stored in Upstash Redis (via Vercel Storage), editable live from
  `/admin` without redeploying. All keys are namespaced with a `fablevideo:`
  prefix.
- **Share links store as a single Redis hash, not one key per link** — loading
  the admin Shares tab or acting on a bulk selection (revoke/unrevoke/delete/
  extend/resend) costs a flat 1-2 Redis commands regardless of how many share
  links exist or are selected, instead of scaling with the count.
- **Opt-in Sentry error monitoring** — client/server/edge configs via the
  instrumentation hooks; inert until `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` are
  set.
- **CI pipeline** — GitHub Actions runs lint + tests + build on every push/PR to
  `main`, catching breakage before Vercel deploys.
- **Smoke tests** — Vitest coverage for the auth check, video-ordering logic,
  theme helpers, and the share-email template.

## Configuration knobs (environment)
- `RESEND_API_KEY` + `EMAIL_FROM` — enable automatic email delivery of share
  links (`EMAIL_REPLY_TO`, `SITE_NAME` optional).
- `BUNNY_CDN_HOSTNAME` — enables thumbnails; `BUNNY_CDN_TOKEN_KEY` signs them when
  the pull-zone token key differs from the embed key.
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` — enable Web Push.
- `NEXT_PUBLIC_SITE_NAME` — portal name in the header.
- `SENTRY_*` — enable error monitoring and source-map upload.
- `GEO_WHITELIST` / `ADMIN_GEO_WHITELIST` — country lists for the geo
  whitelist and its admin bypass; each inert until its own toggle is
  enabled in the Settings tab (Vercel deployments only).
- `ADMIN_GEO_BYPASS_EMAILS` — email-based geo bypass with no toggle; always
  applies once set.
- `CRON_SECRET` — switches on the scheduled transcript collector
  (`/api/cron/transcripts`, scheduled in `vercel.json`). At least 16 random
  characters; Vercel sends it to the job automatically. Unset (or shorter),
  the route answers 404 and collection happens only when an admin opens the
  Videos tab, as before. The schedule is daily (`0 6 * * *`, UTC) because
  Vercel's Hobby plan refuses to deploy anything more frequent; on Pro,
  change it to `*/15 * * * *` for transcripts within a quarter of an hour.

---

## Known gaps / not yet implemented

- **Group-scoped staff** — managers and admins always see the whole library;
  a group restriction applies to viewers only. There is no "manager for these
  videos only" role.
- **Group membership needs both capabilities** — the editor on the Groups tab
  (below) requires `viewers.read` on top of `groups.manage`, because naming a
  group's members hands out addresses. A groups-only manager still sees the
  record and a member count, and still edits what the group may watch; they
  just cannot see or change who is in it.
- **A collection grant follows the collection, not the video** — moving a
  video out of a granted collection removes it from that group's scope on the
  next request, with no warning to whoever moved it. That is the auto-follow
  working as intended, but it means collection membership is now an access
  decision as well as an organisational one.
- **Comments are not implemented** — ratings are (below), but there is no
  free-text discussion anywhere in the portal. That is a deliberate stop: text
  other viewers can read needs moderation, reporting and a notion of who may
  delete whose words, none of which exists here.
- **Library search reads ONE language per video** — the default track, the one ingested first. Indexing every translation of the same sermon would multiply the search payload to return the same video, so searching in Spanish for a talk whose default is English finds nothing. The transcript panel still offers every language once the video is open.
- **Automatic transcript collection is daily unless you are on Vercel Pro** — bunny has no webhook, so finished transcriptions are collected when an admin opens the Videos tab and by a scheduled job. On Hobby the job may only run once a day (Vercel's rule), so without an admin visit a transcript can take up to a day to appear; on Pro the schedule can be every 15 minutes. The job is off until `CRON_SECRET` is set. A job bunny never finishes is given up after three days (long enough for at least two scheduled attempts) and has to be fetched with the button.
- **AI chapters are suggestions, and staying that way is the design** — bunny can generate chapters from the transcript, but nothing on that path writes to the stored list: suggestions are read back read-only (`lib/aiChapters.js`) and land in the admin's textarea, where a person accepts them. A background write would be a second writer for the same field, which is how hand-written chapters get silently replaced. **The field names bunny returns (`title`/`start`) are read from its docs, not from a live job** — this has never run against a real transcription, so the reader accepts a few spellings and reports anything it cannot read rather than returning an empty list.
- **Removing a viewer leaves what was recorded about them** — `removeViewer`
  clears the viewer record and last-seen time, but their progress, saved list
  and votes stay under their email until something deletes them, and nothing
  does yet. Their votes therefore still count in the totals. The data is keyed
  by viewer precisely so that deleting it is one key per feature; deciding to
  do it on removal (and losing a re-added viewer's progress) is an owner call
  that has not been made.
- **Chapters are typed, pasted, or accepted** — there is no per-viewer chapter
  progress. (Pasting a whole video description works already: timestamp lines
  become chapters and every other line is listed as ignored, so nothing is
  dropped silently. What does not exist is reading a description from
  bunny.net automatically.)
- **Passages are read from titles and notes only** — not from what was said.
  The 66-book Protestant canon only; translations are ignored ("John 3:16
  (ESV)" is John 3:16), and verses are checked against a ceiling of 176
  rather than each chapter's real length. Browsing is by book; there is no
  chapter-by-chapter view.
- **Search has no relevance ranking** — results come back in library order,
  not best match first. Word forms are matched (below), but only in titles and
  notes: the spoken-word half is still plain text, because stemming tens of
  kilobytes of transcript per video on every search is a cost the search box
  cannot carry. The stemmer is deliberately small — it knows "baptise" and
  "baptized" are one word, not that "baptism" and "immersion" are.
- **The two halves of search match slightly differently** — titles and notes
  are plain substring; the spoken-word half normalises punctuation and
  apostrophes, so "Christ's" finds "Christs" in a transcript but not in a
  title. Unifying them would change how search has behaved for admins who
  have learned it, so it was left alone deliberately when the server half was
  added.
- **Podcast episodes are video, not audio** — bunny.net Stream has no
  audio-only or MP3 rendition (verified against their docs), so episodes are
  720p MP4s. They play everywhere but are a much larger download than audio.
  They also need **MP4 Fallback** enabled on the bunny.net library, and
  bunny.net only generates an MP4 for videos uploaded *after* that was turned
  on — older recordings need re-uploading.
- **Podcast episode art is the video thumbnail** — a 16:9 frame, while podcast
  apps expect square art, so some apps crop or letterbox it. Custom thumbnails
  set on bunny.net are used when present. The show itself keeps the site icon.
- **Public videos are one at a time, by hand** — there is no public
  collection, no public library page, and no bulk publish. That is the
  intent: one video, one decision, one link.
- **A group window cannot hold a video back, and a repeat is weekly only** —
  per-group windows only ever add time for a group (below); hiding a video from
  one group is what group restrictions are for, and keeping windows additive is
  what makes a missed check fail safe. Repeating windows are one weekly rule per
  video (same hours on each chosen day); there is no monthly or "first Sunday"
  rule, and group windows do not repeat.
- **Some icons stay built-in** — the notification *badge* (Android draws it as
  a one-colour silhouette, so an opaque uploaded picture would be a blob) and
  the offline copies the service worker keeps. Push notifications themselves
  show the custom icon. The service worker's fallback notification title is
  static too; every current sender supplies its own title. A custom icon is
  offered to Android as a plain icon, not a "maskable" one, because an
  arbitrary image has no guaranteed safe zone — Android pads it rather than
  cropping it.
- **Already-installed apps don't re-check the manifest promptly** — a platform
  limitation, not something app code controls: browsers re-check an installed
  PWA's manifest on their own schedule, which can be several app opens or
  days. A fresh install always gets the current name immediately.
