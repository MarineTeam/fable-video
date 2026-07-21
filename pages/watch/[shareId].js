// Plays a video via a private share link: forced Auth0 login, and playback
// only if the logged-in email matches the intended recipient. Mismatches see
// a generic message that never reveals who the link was meant for; expired
// or revoked links show the same clean "expired or doesn't exist" message
// (isShareLive, not mere record existence — see lib/shares.js's grace-window
// comment). Every open stamps the share's view count (preserving TTL).
import Head from "next/head";
import { auth0 } from "../../lib/auth0";
import { normalizeEmail } from "../../lib/auth";
import { getShare, isShareLive, shareViewPatch, updateShare } from "../../lib/shares";
import { signEmbedUrl } from "../../lib/bunny";
import ShareTrackedPlayer from "../../components/ShareTrackedPlayer";
import ShareGateMessage from "../../components/ShareGateMessage";

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
  const user = { email, name: session.user.name || email };

  let share = null;
  try {
    share = await getShare(params.shareId);
  } catch {
    share = null;
  }
  // A record can exist past its nominal expiresAt (grace window, so an
  // admin can Extend it) — that must read as "gone" to the recipient, same
  // as a revoked or never-existed id.
  if (!isShareLive(share)) {
    return { props: { state: "gone", user } };
  }
  if (share.email !== email) {
    // Never reveal the intended recipient.
    return { props: { state: "mismatch", user } };
  }

  await updateShare(params.shareId, shareViewPatch(share)).catch(() => {});

  return {
    props: {
      state: "ok",
      user,
      shareId: params.shareId,
      title: share.videoTitle || "Untitled",
      embedSrc: signEmbedUrl(share.videoId),
    },
  };
}

export default function SharedWatch({ state, user, shareId, title, embedSrc }) {
  if (state === "gone") {
    return (
      <>
        <Head>
          <title>Link unavailable — Marine Video Portal</title>
        </Head>
        <ShareGateMessage title="This link isn&apos;t available" user={user}>
          <p>This private link has expired or doesn&apos;t exist.</p>
        </ShareGateMessage>
      </>
    );
  }

  if (state === "mismatch") {
    return (
      <>
        <Head>
          <title>Private link — Marine Video Portal</title>
        </Head>
        <ShareGateMessage title="This link was made for someone else" user={user}>
          <p>
            This private link only works for the account it was sent to. Try
            signing in with the email address where you received it.
          </p>
        </ShareGateMessage>
      </>
    );
  }

  return (
    <div className="share-page">
      <Head>
        <title>{`${title} — Marine Video Portal`}</title>
      </Head>
      <div className="share-watch">
        <div className="share-watch-head">
          <h1 className="page-title">{title}</h1>
          <span className="muted small">
            Private link for {user.email} ·{" "}
            <a href="/auth/logout" className="inline-link">
              sign out
            </a>
          </span>
        </div>
        <ShareTrackedPlayer src={embedSrc} shareId={shareId} />
      </div>
    </div>
  );
}
