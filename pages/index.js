// Homepage: thumbnail grid (or title list when thumbnails are not
// configured), debounced search, collection filter chips, a continue-watching
// strip with progress bars, and pagination. Login is enforced server-side;
// unapproved users see a clear message and no video data.
import { useCallback, useEffect, useRef, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import AppShell from "../components/AppShell";
import { PlayIcon, SearchIcon } from "../components/icons";
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
          address hasn&apos;t been approved to view the video library. If you
          were expecting access, contact the person who invited you.
        </p>
        <a href="/auth/logout" className="btn btn-ghost">
          Sign out
        </a>
      </div>
    </div>
  );
}

function ContinueWatching({ items, thumbnails }) {
  if (!items.length) return null;
  return (
    <section className="cw-section">
      <h2 className="section-title">Continue watching</h2>
      <div className="cw-strip">
        {items.map((item) => (
          <Link
            key={item.videoId}
            href={`/watch/video/${item.videoId}`}
            className="cw-card"
          >
            {thumbnails && item.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.thumbnail} alt="" className="cw-thumb" />
            ) : (
              <div className="cw-thumb cw-thumb-fallback">
                <PlayIcon size={20} />
              </div>
            )}
            <div className="cw-meta">
              <span className="cw-title">{item.title}</span>
              <span className="muted small">
                Resume at {formatDuration(item.t)}
              </span>
            </div>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${Math.min(100, (item.t / item.d) * 100)}%` }}
              />
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default function Home({ user, admin, approved }) {
  const [videos, setVideos] = useState(null);
  const [meta, setMeta] = useState({ page: 1, totalPages: 1, total: 0, thumbnails: false });
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [collection, setCollection] = useState("");
  const [collections, setCollections] = useState([]);
  const [continueItems, setContinueItems] = useState([]);
  const [error, setError] = useState("");
  const requestSeq = useRef(0);

  const load = useCallback(
    async (page) => {
      const seq = ++requestSeq.current;
      try {
        const params = new URLSearchParams({ page: String(page) });
        if (debouncedQuery) params.set("q", debouncedQuery);
        if (collection) params.set("collection", collection);
        const res = await fetch(`/api/videos?${params}`);
        const data = await res.json().catch(() => null);
        if (seq !== requestSeq.current) return; // stale response
        if (!res.ok) throw new Error(data?.error || "Could not load videos");
        setVideos(data.videos);
        setMeta({
          page: data.page,
          totalPages: data.totalPages,
          total: data.total,
          thumbnails: data.thumbnails,
        });
        setError("");
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(err.message);
        setVideos([]);
      }
    },
    [debouncedQuery, collection]
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!approved) return;
    load(1);
  }, [approved, load]);

  useEffect(() => {
    if (!approved) return;
    fetch("/api/collections")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setCollections(data?.collections || []))
      .catch(() => {});
    fetch("/api/progress")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setContinueItems(data?.items || []))
      .catch(() => {});
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

  const loading = videos === null;

  return (
    <AppShell user={user} admin={admin}>
      <Head>
        <title>Library — Marine Video Portal</title>
      </Head>

      <div className="page-head">
        <h1 className="page-title">Video library</h1>
        <div className="search-box">
          <SearchIcon size={15} />
          <input
            type="search"
            className="search-input"
            placeholder="Search videos…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search videos by title"
          />
        </div>
      </div>

      {collections.length > 0 ? (
        <div className="chip-row">
          <button
            type="button"
            className={`chip ${collection === "" ? "chip-active" : ""}`}
            onClick={() => setCollection("")}
          >
            All
          </button>
          {collections.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`chip ${collection === c.id ? "chip-active" : ""}`}
              onClick={() => setCollection(collection === c.id ? "" : c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
      ) : null}

      {!debouncedQuery && !collection ? (
        <ContinueWatching items={continueItems} thumbnails={meta.thumbnails} />
      ) : null}

      {error ? <div className="notice notice-error">{error}</div> : null}

      {loading ? (
        <div className="muted loading-note">Loading videos…</div>
      ) : videos.length === 0 ? (
        <div className="card empty-state">
          {debouncedQuery || collection
            ? "No videos match your filters."
            : "No videos are available yet."}
        </div>
      ) : meta.thumbnails ? (
        <div className="video-grid">
          {videos.map((video) => (
            <Link
              key={video.id}
              href={`/watch/video/${video.id}`}
              className="video-card"
            >
              <div className="thumb-wrap">
                {video.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={video.thumbnail} alt="" className="thumb" />
                ) : (
                  <div className="thumb thumb-fallback" />
                )}
                <span className="play-overlay">
                  <PlayIcon size={22} />
                </span>
                {video.length ? (
                  <span className="duration-tag">{formatDuration(video.length)}</span>
                ) : null}
              </div>
              <span className="video-card-title">{video.title}</span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="video-list card">
          {videos.map((video) => (
            <Link
              key={video.id}
              href={`/watch/video/${video.id}`}
              className="video-list-row"
            >
              <span className="video-list-play">
                <PlayIcon size={14} />
              </span>
              <span className="video-list-title">{video.title}</span>
              {video.length ? (
                <span className="muted small">{formatDuration(video.length)}</span>
              ) : null}
            </Link>
          ))}
        </div>
      )}

      {!loading && meta.totalPages > 1 ? (
        <div className="pager">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={meta.page <= 1}
            onClick={() => load(meta.page - 1)}
          >
            ← Previous
          </button>
          <span className="muted small">
            Page {meta.page} of {meta.totalPages}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={meta.page >= meta.totalPages}
            onClick={() => load(meta.page + 1)}
          >
            Next →
          </button>
        </div>
      ) : null}
    </AppShell>
  );
}
