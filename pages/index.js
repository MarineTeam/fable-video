// Homepage: thumbnail grid (or title list when thumbnails are not
// configured), debounced search, collection filter chips, a continue-watching
// strip with progress bars, and pagination. The whole (admin-capped) library
// is fetched once — search/filter/pagination happen instantly against it in
// the browser, no round trip per keystroke or chip click. Login is enforced
// server-side; unapproved users see a clear message and no video data.
import { useCallback, useEffect, useMemo, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import AppShell from "../components/AppShell";
import { PlayIcon, SearchIcon } from "../components/icons";
import { auth0 } from "../lib/auth0";
import { isAdmin, normalizeEmail } from "../lib/auth";
import { isApprovedViewer } from "../lib/store";
import { fetchVideoLibrary } from "../lib/videoList";

const PER_PAGE = 10;

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

  // Fetch the library server-side so it's already in the HTML — otherwise
  // the client waits for hydration, then a whole extra fetch/bunny.net
  // round trip, before anything appears.
  let initialVideos = null;
  let initialThumbnails = false;
  if (approved) {
    try {
      const data = await fetchVideoLibrary();
      initialVideos = data.videos;
      initialThumbnails = data.thumbnails;
    } catch {
      // Leave initialVideos null — the client will fetch on mount instead.
    }
  }

  return {
    props: {
      user: { email, name: session.user.name || email },
      admin,
      approved,
      initialVideos,
      initialThumbnails,
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

export default function Home({ user, admin, approved, initialVideos, initialThumbnails }) {
  const [allVideos, setAllVideos] = useState(initialVideos);
  const [thumbnails, setThumbnails] = useState(initialThumbnails);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [collection, setCollection] = useState("");
  const [collections, setCollections] = useState([]);
  const [continueItems, setContinueItems] = useState([]);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");

  const refreshLibrary = useCallback(async () => {
    try {
      const res = await fetch("/api/videos");
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not load videos");
      setAllVideos(data.videos);
      setThumbnails(data.thumbnails);
      setError("");
    } catch (err) {
      setError(err.message);
      setAllVideos([]);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query]);

  // Jump back to page 1 whenever the filters change.
  useEffect(() => {
    setPage(1);
  }, [debouncedQuery, collection]);

  useEffect(() => {
    if (!approved || allVideos !== null) return; // SSR already provided it
    refreshLibrary();
  }, [approved, allVideos, refreshLibrary]);

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

  const loading = allVideos === null;

  const filtered = useMemo(() => {
    if (loading) return [];
    const q = debouncedQuery.toLowerCase();
    return allVideos.filter((video) => {
      if (q && !video.title.toLowerCase().includes(q)) return false;
      if (collection && video.collectionId !== collection) return false;
      return true;
    });
  }, [allVideos, debouncedQuery, collection, loading]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const videos = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

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
    <AppShell user={user} admin={admin} canNotify>
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
        <ContinueWatching items={continueItems} thumbnails={thumbnails} />
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
      ) : thumbnails ? (
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

      {!loading && totalPages > 1 ? (
        <div className="pager">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={safePage <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            ← Previous
          </button>
          <span className="muted small">
            Page {safePage} of {totalPages}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={safePage >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      ) : null}
    </AppShell>
  );
}
