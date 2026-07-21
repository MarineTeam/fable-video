// Lists every video currently shared with one recipient in a single page —
// one bundle per recipient (see lib/bundles.js). Gated exactly like an
// individual share link: forced Auth0 login, and access only if the
// logged-in email matches the bundle's recipient; mismatches and
// gone/expired bundles show the same generic messages as a single share,
// never revealing the intended recipient.
//
// Every item's title/status is read live from its own share record on each
// load (lib/bundles.js's liveBundleItems) — the bundle record itself only
// ever holds ids, so revoking or letting one item expire elsewhere is
// reflected here instantly with no write to the bundle.
import Head from "next/head";
import { auth0 } from "../../../lib/auth0";
import { normalizeEmail } from "../../../lib/auth";
import { getBundle, liveBundleItems } from "../../../lib/bundles";
import { shareUrl } from "../../../lib/shares";
import ShareGateMessage from "../../../components/ShareGateMessage";

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

  let bundle = null;
  try {
    bundle = await getBundle(params.bundleId);
  } catch {
    bundle = null;
  }
  if (!bundle) {
    return { props: { state: "gone", user } };
  }
  if (bundle.email !== email) {
    // Never reveal the intended recipient.
    return { props: { state: "mismatch", user } };
  }

  const items = await liveBundleItems(bundle, params.bundleId);

  return {
    props: {
      state: "ok",
      user,
      items: items
        .map((it) => ({
          id: it.id,
          title: it.videoTitle || "Untitled",
          url: shareUrl(req, it.id),
          expiresAt: it.expiresAt,
        }))
        .sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt)),
    },
  };
}

function formatExpiry(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "soon";
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return "soon";
  const hours = Math.round(ms / 3600000);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

export default function SharedBundle({ state, user, items }) {
  if (state === "gone") {
    return (
      <>
        <Head>
          <title>Link unavailable — Marine Video Portal</title>
        </Head>
        <ShareGateMessage title="This page isn&apos;t available" user={user}>
          <p>This shared collection has expired or doesn&apos;t exist.</p>
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
        <ShareGateMessage title="This page was made for someone else" user={user}>
          <p>
            This shared collection only works for the account it was sent
            to. Try signing in with the email address where you received it.
          </p>
        </ShareGateMessage>
      </>
    );
  }

  return (
    <div className="share-page">
      <Head>
        <title>Shared with you — Marine Video Portal</title>
      </Head>
      <div className="share-watch">
        <div className="share-watch-head">
          <h1 className="page-title">Shared with you</h1>
          <span className="muted small">
            {user.email} ·{" "}
            <a href="/auth/logout" className="inline-link">
              sign out
            </a>
          </span>
        </div>
        {items.length === 0 ? (
          <p className="muted">
            Nothing is currently shared with you — links here may have
            expired or been revoked.
          </p>
        ) : (
          <div className="row-list">
            {items.map((item) => (
              <div key={item.id} className="row">
                <div className="row-main">
                  <strong className="row-title">{item.title}</strong>
                  <span className="muted small">
                    expires {formatExpiry(item.expiresAt)}
                  </span>
                </div>
                <a href={item.url} className="btn btn-primary btn-sm">
                  Watch
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
