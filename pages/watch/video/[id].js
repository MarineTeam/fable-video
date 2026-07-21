// Plays a library video for an approved viewer with a fresh signed embed
// token, remembering playback position via the resumable player.
import Head from "next/head";
import Link from "next/link";
import AppShell from "../../../components/AppShell";
import ResumablePlayer from "../../../components/ResumablePlayer";
import { auth0 } from "../../../lib/auth0";
import { isAdmin, normalizeEmail } from "../../../lib/auth";
import {
  getVideoWatermarkOverride,
  getWatermarkSettings,
  isApprovedViewer,
  isWatermarkExempt,
} from "../../../lib/store";
import { resolveWatermark } from "../../../lib/watermark";
import { getVideo, signEmbedUrl } from "../../../lib/bunny";

export async function getServerSideProps({ req, params, resolvedUrl }) {
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
  const admin = isAdmin(email);
  let approved = admin;
  if (!approved) {
    try {
      approved = await isApprovedViewer(email);
    } catch {
      approved = false;
    }
  }
  if (!approved) {
    return { redirect: { destination: "/", permanent: false } };
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

  return {
    props: {
      user: { email, name: session.user.name || email },
      admin,
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

export default function WatchVideo({ user, admin, video, embedSrc, watermarkText }) {
  return (
    <AppShell user={user} admin={admin} canNotify>
      <Head>
        <title>{`${video.title} — Marine Video Portal`}</title>
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
