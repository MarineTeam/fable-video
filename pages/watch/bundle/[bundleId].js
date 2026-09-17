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
import { blockedByEmailVerification, normalizeEmail } from "../../../lib/auth";
import { getBundle, liveBundleItems } from "../../../lib/bundles";
import { shareUrl } from "../../../lib/shares";
import ShareGateMessage from "../../../components/ShareGateMessage";
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
  // Global setting, resolved before the gone/mismatch branches — see the
  // matching comment in pages/watch/[shareId].js.
  const siteName = await getSiteName().catch(() => null);

  const user = { email, name: session.user.name || email };
  // Email verification, when REQUIRE_VERIFIED_EMAIL is on. Checked HERE, before
  // the link is looked up, so an unverified session cannot use the
  // gone-vs-mismatch distinction as an oracle for whether a link is live.
  //
  // Share recipients are enforced like everyone else, deliberately. They are
  // the users least likely to have a verified address, which is exactly why
  // exempting them would leave a forged unverified session able to match a
  // link's recipient and watch it — the whole attack the toggle exists to stop.
  // ADMIN_EMAILS accounts stay exempt (lib/auth.js), so the recovery path into
  // /admin to switch the toggle back off is never blocked.
  //
  // A notice, not a login redirect: the user IS signed in, so redirecting to
  // /auth/login would bounce them straight back here in a loop.
  if (blockedByEmailVerification(session.user)) {
    return { props: { state: "unverified", user, siteName } };
  }

  let bundle = null;
  try {
    bundle = await getBundle(params.bundleId);
  } catch {
    bundle = null;
  }
  if (!bundle) {
    return { props: { state: "gone", user, siteName } };
  }
  if (bundle.email !== email) {
    // Never reveal the intended recipient.
    return { props: { state: "mismatch", user, siteName } };
  }

  const items = await liveBundleItems(bundle, params.bundleId);

  return {
    props: {
      state: "ok",
      user,
      siteName,
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

export const getServerSideProps = withMonitorPage(gssp);

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

export default function SharedBundle({ state, user, items, siteName }) {
  if (state === "gone") {
    return (
      <>
        <Head>
          <title>{pageTitle("Link unavailable", siteName)}</title>
        </Head>
        <ShareGateMessage title="This page isn&apos;t available" user={user}>
          <p>This shared collection has expired or doesn&apos;t exist.</p>
        </ShareGateMessage>
      </>
    );
  }

  if (state === "unverified") {
    return (
      <>
        <Head>
          <title>{pageTitle("Verify your email", siteName)}</title>
        </Head>
        <ShareGateMessage title="Verify your email address" user={user}>
          <p>
            This portal requires a verified email address. Check your inbox for
            the verification link, then sign in again to open this page.
          </p>
        </ShareGateMessage>
      </>
    );
  }

  if (state === "mismatch") {
    return (
      <>
        <Head>
          <title>{pageTitle("Private link", siteName)}</title>
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
        <title>{pageTitle("Shared with you", siteName)}</title>
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
