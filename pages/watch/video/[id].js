// Plays a library video for an approved viewer with a fresh signed embed
// token, remembering playback position via the resumable player.
import Head from "next/head";
import Link from "next/link";
import AppShell from "../../../components/AppShell";
import ResumablePlayer from "../../../components/ResumablePlayer";
import { auth0 } from "../../../lib/auth0";
import { isAdmin, normalizeEmail } from "../../../lib/auth";
import { isApprovedViewer } from "../../../lib/store";
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
    },
  };
}

export default function WatchVideo({ user, admin, video, embedSrc }) {
  return (
    <AppShell user={user} admin={admin}>
      <Head>
        <title>{`${video.title} — Marine Video Portal`}</title>
      </Head>
      <div className="watch-head">
        <Link href="/" className="back-link">
          ← Back to library
        </Link>
        <h1 className="page-title">{video.title}</h1>
      </div>
      <ResumablePlayer src={embedSrc} videoId={video.id} />
    </AppShell>
  );
}
