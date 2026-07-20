// Plays a video via a private share link: forced Auth0 login, and playback
// only if the logged-in email matches the intended recipient. Mismatches see
// a generic message that never reveals who the link was meant for; expired
// or revoked links show a clean "expired or doesn't exist" message. The
// first successful open stamps the share's viewed status (preserving TTL).
import Head from "next/head";
import { auth0 } from "../../lib/auth0";
import { normalizeEmail } from "../../lib/auth";
import { getShare, shareViewPatch, updateShare } from "../../lib/shares";
import { signEmbedUrl } from "../../lib/bunny";
import ShareTrackedPlayer from "../../components/ShareTrackedPlayer";

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
  if (!share) {
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

function ShareMessage({ title, children, user }) {
  return (
    <div className="share-page">
      <div className="center-panel">
        <div className="card narrow-card">
          <h1 className="panel-title">{title}</h1>
          <div className="muted">{children}</div>
          <p className="muted small">
            Signed in as <strong>{user.email}</strong>
          </p>
          <a href="/auth/logout" className="btn btn-ghost">
            Sign out / switch account
          </a>
        </div>
      </div>
    </div>
  );
}

export default function SharedWatch({ state, user, shareId, title, embedSrc }) {
  if (state === "gone") {
    return (
      <>
        <Head>
          <title>Link unavailable — Marine Video Portal</title>
        </Head>
        <ShareMessage title="This link isn&apos;t available" user={user}>
          <p>This private link has expired or doesn&apos;t exist.</p>
        </ShareMessage>
      </>
    );
  }

  if (state === "mismatch") {
    return (
      <>
        <Head>
          <title>Private link — Marine Video Portal</title>
        </Head>
        <ShareMessage title="This link was made for someone else" user={user}>
          <p>
            This private link only works for the account it was sent to. Try
            signing in with the email address where you received it.
          </p>
        </ShareMessage>
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
