# Features

A catalog of what the Marine Video Portal does, grouped by audience. For setup
and architecture, see [README.md](./README.md).

---

## For viewers

### Sign-in and access control
- Auth0-backed login; every page and API route requires a valid session.
- Four-tier access model: anonymous → signed-in-but-unapproved → approved
  viewer → admin. Unapproved users get a clear message and never receive video
  data.
- **Idle timeout:** an open portal signs itself out after 30 minutes of
  inactivity, protecting sessions left open on shared machines.
- **Rolling sessions:** the session refreshes on ordinary page and API traffic
  so active users aren't logged out mid-session.

### Browsing the library
- **Thumbnail grid** of the available videos, with duration badges and a
  play-on-hover overlay. Falls back to a clean **title list** when thumbnails
  aren't configured.
- **Instant search:** the whole (admin-capped) library loads once, then search
  runs client-side against it — no round trip per keystroke. Input is debounced.
- **Collection filters:** filter chips let viewers narrow the library to a
  single collection; filtering is instant and client-side.
- **Pagination:** results are paged (10 per page) and reset to page one whenever
  the search or collection filter changes.
- **Server-rendered first paint:** the library is fetched on the server and
  embedded in the initial HTML, so content appears without waiting for
  hydration plus a second fetch.

### Watching
- **Tokenized playback:** every video plays through a fresh, time-limited embed
  token. Direct file URLs are never exposed.
- **Resume where you left off:** the player remembers each viewer's position per
  video. Reopening a video seeks back to the saved spot; progress is saved on
  pause, on end, and periodically during playback.
- **Continue watching:** the homepage shows a strip of in-progress videos with
  progress bars, newest first, so viewers can jump straight back in. Finished
  and barely-started videos are excluded.
- **Graceful degradation:** if the player-control protocol is unavailable,
  plain playback still works — only the resume feature quietly no-ops.

### Notifications (opt-in)
- **Web Push:** viewers can enable browser notifications to be told when a new
  video becomes available. The toggle reflects browser support and permission
  state, and hides itself where push isn't supported or configured.
- **New-video announcements:** when a freshly uploaded video finishes
  transcoding, subscribers are notified once. The first run seeds silently so
  the existing library isn't blasted out, and concurrent servers never
  double-send.

### Installable app (PWA)
- Web app manifest and icons make the portal installable to a home screen.
- A service worker caches only static icons — never auth, API data, or
  tokenized video/thumbnail URLs.

### Theming
- The admin-chosen accent palette is applied site-wide via CSS variables.
- The palette is cached client-side and applied before first paint, so
  returning visitors never see a color flash.

---

## Private share links

A way to send a single video to a specific person without adding them to the
viewer list.

- **Per-recipient links:** each link is tied to one email address. Opening it
  requires signing in as that exact address — anyone else sees a generic
  "made for someone else" message that never reveals the intended recipient.
- **Expiring by design:** links carry a TTL (default 72 hours, up to 30 days)
  and stop working automatically. Expired or revoked links show a clean
  "expired or doesn't exist" message.
- **Automatic email delivery:** when email is configured, creating a share sends
  the recipient a branded email with the link. If delivery fails, the link is
  never lost — it can be copied manually or re-sent from the admin panel.
- **Tracked and revocable:** the admin sees whether each link has been emailed
  and viewed, plus its exact expiry, and can revoke any link instantly.
- **Unguessable IDs:** share IDs are random 16-byte tokens, validated by format
  before any lookup.

---

## For admins

The admin panel lives at `/admin` and is organized into six tabs. Every admin
action is checked server-side on its own route and recorded in the activity log.

### Videos
- **Direct uploads:** files upload straight from the browser to bunny.net over
  signed, resumable (TUS) credentials — the app server never handles the bytes.
  Uploads can be assigned to a collection and titled at creation.
- **Encoding status:** each video shows whether it's processing, ready, or
  failed, with transcoding progress.
- **Rename** videos and **assign or clear collections** inline.
- **Delete** videos (which also removes them from the saved custom order).
- **Custom ordering:** drag to arrange how videos appear on the homepage. New
  uploads float to the top (newest first) until positioned.

### Viewers
- **Add viewers** one at a time or by pasting a bulk list — addresses are
  validated, normalized, and de-duplicated, with invalid entries reported back.
- **Remove viewers** to revoke access immediately.
- **Last-seen tracking:** see when each viewer last accessed the portal.

### Shares
- List every active share link with its recipient, video, viewed/emailed
  status, and exact expiry.
- **Resend** a delivery email (useful for links created before email was
  configured, sends that failed, or recipients who lost the message).
- **Revoke** any link on the spot.

### Settings
- **Homepage video count:** cap how many videos appear in the viewer library
  (1–100).
- **Theme palette:** choose from seven presets or set custom accent colors,
  applied to every visitor.
- Read-only status of email and push configuration.

### Activity
- An append-only **audit log** of recent admin actions — uploads, renames,
  viewer changes, shares, revocations, settings and theme changes, broadcasts —
  each stamped with the actor and time. Capped to the most recent entries.

### Analytics
- Total views, 30-day views, and watch-time hours.
- A 30-day views chart and a most-watched list, sourced from bunny.net's video
  and statistics APIs.

### Broadcast
- Send a manual **push notification** to every currently approved viewer (and
  admins). Click-through targets are restricted to same-origin paths.

---

## Security and resilience

- **Independent admin guard:** every `/api/admin/*` route re-verifies admin
  status regardless of the page gate.
- **Fail closed on access:** approval checks and share-recipient checks deny on
  any error rather than leak content.
- **Fail open on infrastructure:** rate limiting and audit logging never lock
  out or block a legitimate user if Redis is momentarily unavailable.
- **Rate limiting:** sliding-window limits protect the library, upload, share,
  and broadcast endpoints.
- **Signed, time-limited tokens** for both video embeds and thumbnails, so
  content can't be hotlinked and works with direct-URL access blocked at the
  CDN.
- **Recipient privacy:** a mismatched share link never discloses who it was
  meant for.
- **Best-effort side effects:** notifications, last-seen stamps, and audit
  writes never break the primary action they accompany.
- **Error monitoring:** Sentry captures server and client errors when a DSN is
  configured (inert otherwise).
