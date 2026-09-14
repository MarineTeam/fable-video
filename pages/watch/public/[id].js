// The ONE route in this app that serves a video without a session.
//
// It is a separate page on purpose. Every other viewer-facing path —
// pages/index.js, pages/api/videos.js, pages/api/collections.js,
// pages/watch/video/[id].js — is an invite-only gate, and adding an
// "...or the video is public" branch to any of them would mean every future
// change to those files had to re-reason about the anonymous case. This file
// does exactly one thing, so it is the only file to audit when asking "what
// can someone with no account reach?".
//
// What it deliberately does NOT do:
//   * no search, no collection list, no counts, no "related videos", no link
//     into the library — nothing that hints other videos exist;
//   * no progress tracking, no last-seen stamp, no push subscription — those
//     are all keyed by email and there is no email here. It uses a bare
//     <iframe> rather than ResumablePlayer for exactly that reason: the
//     player wrapper posts to /api/progress, and the surest way to not track
//     an anonymous visitor is to not ship the code that would;
//   * no watermark — a watermark stamps a viewer's identity onto the frame,
//     and there is no identity to stamp;
//   * no indexing — "public" here means "no login required", not "publish to
//     search engines". A link you hand someone is not a page you list.
//
// What it DOES still enforce:
//   * the public flag, default-deny, failing CLOSED on a Redis error
//     (lib/publicVideos.js explains why this one inverts the usual polarity);
//   * the publish/expiry window — a public video outside its window is gone,
//     same as for a signed-in viewer;
//   * a signed, time-limited bunny.net embed token. "Public" does not mean an
//     unsigned or permanent URL; invariant (d) is untouched here.
//   * the geo whitelist, by construction — proxy.js enforces it at the
//     network boundary for every matched route, and this route is matched.
//
// Groups are not consulted, and that is correct rather than an omission: a
// group narrows what a *viewer* may see, and a public visitor is not a viewer.
import Head from "next/head";
import { getVideo, signEmbedUrl } from "../../../lib/bunny";
import { isPublicVideo } from "../../../lib/publicVideos";
import { getSchedule, isLive } from "../../../lib/schedule";
import { getChapters, getNotes } from "../../../lib/videoMeta";
import { formatTimestamp } from "../../../lib/chapters";
import { notesLines } from "../../../lib/notes";
import { pageTitle } from "../../../lib/siteName";
import { getSiteName } from "../../../lib/store";
import { oneString } from "../../../lib/params";
import { allowRequest } from "../../../lib/ratelimit";
import { withMonitorPage } from "../../../lib/monitor";

// This page is reachable by anyone on the internet and does a bunny.net API
// call per load, so it gets its own budget keyed by client IP. The limiter
// fails open by design (lib/ratelimit.js) — that is unchanged here: a Redis
// outage must not take a working public link down, and the public flag check
// below is the control that actually matters.
function clientIp(req) {
  // Node hands back an array when a header repeats; strict-read it rather
  // than stringifying, for the same reason as every other param here.
  const forwarded = oneString(req.headers["x-forwarded-for"]) || "";
  return forwarded.split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
}

async function gssp({ req, params }) {
  // 1. The flag. Default deny; false on absence AND on any Redis error.
  if (!(await isPublicVideo(params.id))) return { notFound: true };

  if (!(await allowRequest("public-watch", clientIp(req), 60, "1 m"))) {
    return { notFound: true };
  }

  // 2. The publish window. Note the catch: this fails CLOSED, the opposite of
  // pages/watch/video/[id].js, which treats an unreadable schedule as "no
  // constraint". There, the viewer is already entitled to the library and
  // hiding it would be the bigger harm. Here, an unreadable schedule means we
  // cannot prove the video is inside its window, and publishing something
  // outside its window to the open internet is the bigger harm.
  let schedule = null;
  try {
    schedule = await getSchedule(params.id);
  } catch (err) {
    console.error("Could not read the schedule for a public video:", err);
    return { notFound: true };
  }
  if (!isLive(schedule)) return { notFound: true };

  // 3. The video itself.
  let video;
  try {
    video = await getVideo(params.id);
  } catch {
    return { notFound: true };
  }
  if (!video?.guid) return { notFound: true };

  // Decoration only, best-effort — same posture as the signed-in watch page.
  let chapters = [];
  let notes = null;
  try {
    [chapters, notes] = await Promise.all([getChapters(params.id), getNotes(params.id)]);
  } catch (err) {
    console.error("Could not read a public video's chapters or notes:", err);
  }

  const siteName = await getSiteName().catch(() => null);

  return {
    props: {
      siteName,
      video: { title: video.title || "Untitled" },
      // 4. Still a signed, time-limited token, generated per request and
      // never stored — exactly as for a signed-in viewer.
      embedSrc: signEmbedUrl(video.guid),
      chapters,
      notes,
    },
  };
}

export const getServerSideProps = withMonitorPage(gssp);

export default function PublicWatch({ siteName, video, embedSrc, chapters, notes }) {
  const list = Array.isArray(chapters) ? chapters : [];
  return (
    <div className="public-page">
      <Head>
        <title>{pageTitle(video.title, siteName)}</title>
        {/* "No login required" is not "list me in Google". */}
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <main className="public-main">
        <header className="public-head">
          <span className="public-site">{siteName}</span>
          <h1 className="page-title">{video.title}</h1>
        </header>
        <div className="player-frame">
          <iframe
            src={embedSrc}
            loading="eager"
            allow="accelerometer; gyroscope; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            title="Video player"
          />
        </div>
        {list.length ? (
          <section className="chapters card">
            <h2 className="chapters-title">Chapters</h2>
            {/* Static, not clickable. Seeking needs the player.js wrapper,
                and the wrapper is what reports progress — for an anonymous
                visitor the honest trade is a list you can read off rather
                than tracking we have nobody to attribute. */}
            <ol className="chapter-list">
              {list.map((chapter, index) => (
                <li key={`${chapter.t}-${index}`} className="chapter-row">
                  <span className="chapter-static">
                    <span className="chapter-time">{formatTimestamp(chapter.t)}</span>
                    <span className="chapter-label">{chapter.label}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {notes ? (
          <section className="notes card">
            <h2 className="notes-title">Notes</h2>
            <div className="notes-body">
              {notesLines(notes).map((line, index) => (
                <p key={index} className="notes-line">
                  {line || " "}
                </p>
              ))}
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
