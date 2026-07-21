// Per-viewer watch history — every video this viewer has made progress on,
// finished or not, most-recent first. Same login+approval gate as the
// homepage (pages/index.js), enforced server-side.
import { useEffect, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import AppShell from "../components/AppShell";
import { PlayIcon } from "../components/icons";
import { auth0 } from "../lib/auth0";
import { isAdmin, normalizeEmail } from "../lib/auth";
import { isApprovedViewer } from "../lib/store";

export async function getServerSideProps({ req, resolvedUrl }) {
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

  return {
    props: {
      user: { email, name: session.user.name || email },
      admin,
      approved,
    },
  };
}

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

export default function Activity({ user, admin, approved }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!approved) return;
    fetch("/api/progress?all=1")
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || "Could not load watch history");
        setItems(data.items || []);
      })
      .catch((err) => {
        setError(err.message);
        setItems([]);
      });
  }, [approved]);

  if (!approved) {
    return (
      <AppShell user={user} admin={admin}>
        <Head>
          <title>Not approved — Marine Video Portal</title>
        </Head>
        <NotApproved user={user} />
      </AppShell>
    );
  }

  return (
    <AppShell user={user} admin={admin}>
      <Head>
        <title>My activity — Marine Video Portal</title>
      </Head>
      <div className="page-head">
        <h1 className="page-title">My activity</h1>
      </div>
      {error ? <div className="notice notice-error">{error}</div> : null}
      {items === null ? (
        <div className="muted loading-note">Loading…</div>
      ) : items.length === 0 ? (
        <div className="card empty-state">
          You haven&apos;t watched any videos yet.
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
