// Per-viewer watch history — every video this viewer has made progress on,
// finished or not, most-recent first. Same login+approval gate as the
// homepage (pages/index.js), enforced server-side.
import { useEffect, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import AppShell from "../components/AppShell";
import { PlayIcon } from "../components/icons";
import { auth0 } from "../lib/auth0";
import { blockedByEmailVerification, normalizeEmail } from "../lib/auth";
import { isStaffRole, resolveAccess } from "../lib/roles";
import { pageTitle } from "../lib/siteName";
import { getSiteName } from "../lib/store";
import { withMonitorPage } from "../lib/monitor";

async function gssp({ req, resolvedUrl }) {
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
  const siteName = await getSiteName().catch(() => null);
  const unverified = blockedByEmailVerification(session.user);
  const access = unverified ? null : await resolveAccess(email);
  const admin = unverified ? false : isStaffRole(access.role);
  const approved = unverified ? false : access.approved;

  return {
    props: {
      user: { email, name: session.user.name || email },
      admin,
      approved,
      siteName,
    },
  };
}

export const getServerSideProps = withMonitorPage(gssp);

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function NotApproved({ user }) {
  return (
    <div className="center-panel">
      <div className="card narrow-card">
        <h1 className="panel-title">Your account isn&apos;t approved yet</h1>
        <p className="muted">
          You&apos;re signed in as <strong>{user.email}</strong>, but this
          address hasn&apos;t been approved to view the video library.
        </p>
        <a href="/auth/logout" className="btn btn-ghost">
          Sign out
        </a>
      </div>
    </div>
  );
}

// The viewer's own podcast feed address.
//
// Lives here rather than in the nav because it is a personal, per-account
// thing — the same reason this page exists. It is only ever the signed-in
// viewer's own link: there is deliberately no way for an admin to read
// someone else's, and the "View as" picker above does not reach it.
function PodcastFeed() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/feed-token")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setState(data || { enabled: false }))
      .catch(() => setState({ enabled: false }));
  }, []);

  const regenerate = async () => {
    setBusy(true);
    setCopied(false);
    try {
      const res = await fetch("/api/feed-token", { method: "POST" });
      if (res.ok) setState(await res.json());
    } catch {
      // Leave the existing link on screen; it still works.
    }
    setBusy(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(state.url);
      setCopied(true);
    } catch {
      // Clipboard blocked — the address is on screen to copy by hand.
    }
  };

  // Nothing at all when the feature is off, so the page is unchanged for a
  // portal that never turns it on.
  if (!state?.enabled || !state?.url) return null;

  return (
    <div className="card podcast-card">
      <h2 className="chapters-title">Listen in a podcast app</h2>
      <p className="muted small">
        Paste this address into your podcast app to get new recordings
        automatically. It is yours alone — treat it like a password, because
        anyone you give it to sees what you see.
        {state.mediaReady ? "" : " (No episodes yet — ask an admin to finish setup.)"}
      </p>
      <input
        className="input"
        readOnly
        value={state.url}
        onFocus={(e) => e.target.select()}
        aria-label="Your private podcast feed address"
      />
      <div className="row-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
          {copied ? "Copied" : "Copy address"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy}
          onClick={regenerate}
          title="Replaces the address everywhere — use this if you shared it by mistake"
        >
          Regenerate
        </button>
      </div>
    </div>
  );
}

export default function Activity({ user, admin, approved, siteName }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [viewers, setViewers] = useState([]);
  const [viewAs, setViewAs] = useState("");

  useEffect(() => {
    if (!admin) return;
    fetch("/api/admin/viewers")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setViewers(data?.viewers || []))
      .catch(() => {});
  }, [admin]);

  useEffect(() => {
    if (!approved) return;
    setItems(null);
    setError("");
    const url = viewAs
      ? `/api/progress?all=1&email=${encodeURIComponent(viewAs)}`
      : "/api/progress?all=1";
    fetch(url)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || "Could not load watch history");
        setItems(data.items || []);
      })
      .catch((err) => {
        setError(err.message);
        setItems([]);
      });
  }, [approved, viewAs]);

  if (!approved) {
    return (
      <AppShell user={user} admin={admin} siteName={siteName}>
        <Head>
          <title>{pageTitle("Not approved", siteName)}</title>
        </Head>
        <NotApproved user={user} />
      </AppShell>
    );
  }

  return (
    <AppShell user={user} admin={admin} siteName={siteName}>
      <Head>
        <title>{pageTitle("My activity", siteName)}</title>
      </Head>
      {viewAs ? null : <PodcastFeed />}
      <div className="page-head">
        <h1 className="page-title">{viewAs ? `${viewAs}'s activity` : "My activity"}</h1>
        {admin ? (
          <label className="field activity-viewer-picker">
            <span className="field-label">View as</span>
            <select
              className="input"
              value={viewAs}
              onChange={(e) => setViewAs(e.target.value)}
            >
              <option value="">Myself</option>
              {viewers.map((v) => (
                <option key={v.email} value={v.email}>
                  {v.email}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {error ? <div className="notice notice-error">{error}</div> : null}
      {items === null ? (
        <div className="muted loading-note">Loading…</div>
      ) : items.length === 0 ? (
        <div className="card empty-state">
          {viewAs
            ? `${viewAs} hasn't watched any videos yet.`
            : "You haven't watched any videos yet."}
        </div>
      ) : (
        <div className="card">
          <div className="row-list">
            {items.map((item) => (
              <div key={item.videoId} className="row">
                <Link
                  href={`/watch/video/${item.videoId}`}
                  className="row-main activity-row-link"
                >
                  <strong className="row-title">{item.title}</strong>
                  <span className="muted small">
                    {item.completed
                      ? "Completed"
                      : `Resume at ${formatDuration(item.t)} of ${formatDuration(item.d)}`}
                    {item.updatedAt
                      ? ` · last watched ${new Date(item.updatedAt).toLocaleString()}`
                      : ""}
                  </span>
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{ width: `${item.percent}%` }}
                    />
                  </div>
                </Link>
                {item.completed ? (
                  <span className="badge badge-ok">Completed</span>
                ) : (
                  <span className="badge">{item.percent}% watched</span>
                )}
                <Link
                  href={`/watch/video/${item.videoId}`}
                  className="btn btn-ghost btn-sm"
                >
                  <PlayIcon size={13} /> {item.completed ? "Watch again" : "Resume"}
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
    </AppShell>
  );
}
