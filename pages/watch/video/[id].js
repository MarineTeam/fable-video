// Plays a library video for an approved viewer with a fresh signed embed
// token, remembering playback position via the resumable player.
import Head from "next/head";
import Link from "next/link";
import AppShell from "../../../components/AppShell";
import ResumablePlayer from "../../../components/ResumablePlayer";
import { auth0 } from "../../../lib/auth0";
import { blockedByEmailVerification, normalizeEmail } from "../../../lib/auth";
import { isStaffRole, resolveAccess, scopeAllows } from "../../../lib/roles";
import {
  getVideoWatermarkOverride,
  getWatermarkSettings,
  isWatermarkExempt,
} from "../../../lib/store";
import { resolveWatermark } from "../../../lib/watermark";
import { getVideo, signEmbedUrl } from "../../../lib/bunny";
import { getSchedule, isLive } from "../../../lib/schedule";
import { pageTitle } from "../../../lib/siteName";
import { getSiteName } from "../../../lib/store";
import { withMonitorPage } from "../../../lib/monitor";

async function gssp({ req, params, resolvedUrl }) {
  const session = await auth0.getSession(req);
  const email = session?.user?.email ? normalizeEmail(session.user.email) : null;
  if (!email) {
    return {
      redirect: {
        destination: `/auth/login?returnTo=${encodeURIComponent(resolvedUrl)}`,
        permanent: false,
      },
    };
  }
  if (blockedByEmailVerification(session.user)) {
    return { redirect: { destination: "/", permanent: false } };
  }
  const access = await resolveAccess(email);
  const admin = isStaffRole(access.role);
  if (!access.approved) {
    return { redirect: { destination: "/", permanent: false } };
  }

  // Group scoping is enforced HERE, not merely by omitting the video from
  // the library list — the id is in the URL, so a restricted viewer who
  // learns an id another way must still be turned away before any signed
  // embed token is minted for it. 404 rather than 403: a restricted viewer
  // should not be able to probe which ids exist.
  if (!scopeAllows(access.videoScope, params.id)) {
    return { notFound: true };
  }

  // Same reasoning as the scope check above: a video outside its publish
  // window must be unreachable by URL, not merely absent from the list, or
  // a bookmark from before it expired would still mint a playback token.
  // Staff are exempt so an admin can preview an unpublished video.
  if (!admin) {
    let schedule = null;
    try {
      schedule = await getSchedule(params.id);
    } catch (err) {
      // Matches lib/videoList.js: an unreadable schedule means no
      // constraint, rather than taking live content off the air.
      console.error("Could not read the video schedule:", err);
    }
    if (!isLive(schedule)) return { notFound: true };
  }

  let video;
  try {
    video = await getVideo(params.id);
  } catch {
    return { notFound: true };
  }
  if (!video?.guid) return { notFound: true };

  // Best-effort — a watermark-resolution failure must never block playback,
  // it just falls back to no watermark for this load.
  let watermarkText = null;
  try {
    const [{ enabled }, videoMode, exempt] = await Promise.all([
      getWatermarkSettings(),
      getVideoWatermarkOverride(video.guid),
      isWatermarkExempt(email),
    ]);
    // No per-share layer applies here — this is direct approved-viewer
    // playback, not a share link.
    if (resolveWatermark({ globalEnabled: enabled, videoMode, exempt })) {
      watermarkText = `${email} · ${new Date().toLocaleString()}`;
    }
  } catch (err) {
    console.error("Could not resolve watermark settings:", err);
  }

  const siteName = await getSiteName().catch(() => null);

  return {
    props: {
      user: { email, name: session.user.name || email },
      admin,
      siteName,
      video: {
        id: video.guid,
        title: video.title || "Untitled",
        length: video.length || 0,
      },
      embedSrc: signEmbedUrl(video.guid),
      watermarkText,
    },
  };
}

export const getServerSideProps = withMonitorPage(gssp);

export default function WatchVideo({
  user,
  admin,
  video,
  embedSrc,
  watermarkText,
  siteName,
}) {
  return (
    <AppShell user={user} admin={admin} canNotify siteName={siteName}>
      <Head>
        <title>{pageTitle(video.title, siteName)}</title>
      </Head>
      <div className="watch-head">
        <Link href="/" className="back-link">
          ← Back to library
        </Link>
        <h1 className="page-title">{video.title}</h1>
      </div>
      <ResumablePlayer src={embedSrc} videoId={video.id} watermark={watermarkText} />
    </AppShell>
  );
}
