// Tabbed admin panel: Videos / Viewers / Shares / Settings / Activity /
// Analytics. Gated server-side (non-admins are redirected before any admin
// UI is sent); every /api/admin/* route independently returns 403 as well.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import AppShell from "../components/AppShell";
import {
  CheckIcon,
  CopyIcon,
  GripIcon,
  LinkIcon,
  MailIcon,
  PencilIcon,
  TrashIcon,
  UploadIcon,
  XIcon,
} from "../components/icons";
import { auth0 } from "../lib/auth0";
import { isAdmin, normalizeEmail } from "../lib/auth";
import { PRESETS } from "../lib/theme";
import { applyResolvedTheme } from "../lib/theme-client";

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
  if (!isAdmin(email)) {
    return { redirect: { destination: "/", permanent: false } };
  }
  return {
    props: { user: { email, name: session.user.name || email }, admin: true },
  };
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function timeAgo(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}

function expiresIn(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  const hours = ms / 3600000;
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60000))} min`;
  if (hours < 48) return `${Math.floor(hours)} h`;
  return `${Math.floor(hours / 24)} d`;
}

function StatusBadge({ video }) {
  if (video.status === "failed") {
    return <span className="badge badge-danger">Failed</span>;
  }
  if (video.status === "processing") {
    return (
      <span className="badge badge-warn">
        Processing {Math.round(video.encodeProgress || 0)}%
      </span>
    );
  }
  return <span className="badge badge-ok">Ready</span>;
}

/* ------------------------------------------------------------------ */
/* Share creation                                                      */
/* ------------------------------------------------------------------ */

function ShareCreator({ video, emailConfigured, onClose, onCreated }) {
  const [email, setEmail] = useState("");
  const [hours, setHours] = useState(72);
  const [sendMail, setSendMail] = useState(emailConfigured);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api("/api/admin/share", {
        method: "POST",
        body: {
          videoId: video.id,
          email,
          hours: Number(hours),
          sendEmail: sendMail,
        },
      });
      setResult(data);
      onCreated?.();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy — select the link text manually");
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Create private share link">
        <div className="modal-head">
          <h3 className="modal-title">Private share link</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <XIcon size={16} />
          </button>
        </div>
        <p className="muted small">{video.title}</p>

        {result ? (
          <div className="share-result">
            <div className="share-link-box">
              <code className="share-link">{result.url}</code>
              <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
                {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                {copied ? " Copied" : " Copy"}
              </button>
            </div>
            {result.emailed ? (
              <p className="notice notice-ok">
                <MailIcon size={14} /> Emailed to {email.trim().toLowerCase()}.
              </p>
            ) : result.emailError ? (
              <p className="notice notice-error">
                The link was created but the email failed: {result.emailError}.
                Copy the link and send it manually, or retry from the Shares
                tab.
              </p>
            ) : (
              <p className="muted small">
                Copy the link and send it to {email.trim().toLowerCase()}.
              </p>
            )}
            <p className="muted small">
              Expires {new Date(result.expiresAt).toLocaleString()}. Manage it
              from the Shares tab.
            </p>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={create} className="stack">
            <label className="field">
              <span className="field-label">Recipient email</span>
              <input
                type="email"
                className="input"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="person@example.com"
              />
            </label>
            <label className="field">
              <span className="field-label">Expires after (hours, max 720)</span>
              <input
                type="number"
                className="input"
                min="1"
                max="720"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={sendMail && emailConfigured}
                disabled={!emailConfigured}
                onChange={(e) => setSendMail(e.target.checked)}
              />
              <span>
                Email the link to the recipient
                {!emailConfigured ? (
                  <span className="muted small block">
                    (email delivery isn&apos;t configured — see Settings)
                  </span>
                ) : null}
              </span>
            </label>
            {error ? <div className="notice notice-error">{error}</div> : null}
            <div className="row-actions">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                <LinkIcon size={14} /> {busy ? "Creating…" : "Create link"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Videos tab                                                          */
/* ------------------------------------------------------------------ */

function VideosTab({ emailConfigured, onSharesChanged }) {
  const [videos, setVideos] = useState(null);
  const [thumbs, setThumbs] = useState(false);
  const [collections, setCollections] = useState([]);
  const [search, setSearch] = useState("");
  const [uploads, setUploads] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [shareFor, setShareFor] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [newCollection, setNewCollection] = useState("");
  const [error, setError] = useState("");
  const dragIndex = useRef(null);
  const fileInput = useRef(null);
  const tusUploads = useRef(new Map());
  const videosRef = useRef([]);

  useEffect(() => {
    videosRef.current = videos || [];
  }, [videos]);

  const load = useCallback(async () => {
    try {
      const [v, c] = await Promise.all([
        api("/api/admin/videos"),
        api("/api/admin/collections"),
      ]);
      setVideos(v.videos);
      setThumbs(v.thumbnails);
      setCollections(c.collections);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh encoding badges while anything is processing.
  const anyProcessing = (videos || []).some((v) => v.status === "processing");
  useEffect(() => {
    if (!anyProcessing) return undefined;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [anyProcessing, load]);

  const patchUpload = (key, patch) =>
    setUploads((list) =>
      list.map((u) => (u.key === key ? { ...u, ...patch } : u))
    );

  const startUpload = useCallback(
    async (file, existingKey) => {
      const key =
        existingKey || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const title = file.name.replace(/\.[^.]+$/, "") || file.name;
      if (existingKey) {
        patchUpload(key, { state: "creating", progress: 0, error: null, videoId: null });
      } else {
        setUploads((list) => [
          ...list,
          { key, file, title, progress: 0, state: "creating", error: null, videoId: null },
        ]);
      }
      try {
        const created = await api("/api/admin/upload", {
          method: "POST",
          body: { title },
        });
        const { Upload } = await import("tus-js-client");
        const upload = new Upload(file, {
          endpoint: created.tus.endpoint,
          retryDelays: [0, 3000, 6000, 12000],
          headers: {
            AuthorizationSignature: created.tus.signature,
            AuthorizationExpire: String(created.tus.expire),
            VideoId: created.tus.videoId,
            LibraryId: created.tus.libraryId,
          },
          metadata: { filetype: file.type, title },
          onError: (err) =>
            patchUpload(key, {
              state: "error",
              error: err?.message || "Upload failed",
            }),
          onProgress: (sent, total) =>
            patchUpload(key, {
              progress: total ? Math.round((sent / total) * 100) : 0,
            }),
          onSuccess: () => {
            patchUpload(key, { state: "done", progress: 100 });
            tusUploads.current.delete(key);
            load();
          },
        });
        tusUploads.current.set(key, upload);
        patchUpload(key, { state: "uploading", videoId: created.video.id });
        upload.start();
      } catch (err) {
        patchUpload(key, { state: "error", error: err.message });
      }
    },
    [load]
  );

  const cancelUpload = (entry) => {
    const upload = tusUploads.current.get(entry.key);
    try {
      if (upload) upload.abort(true);
    } catch {
      // already stopped
    }
    tusUploads.current.delete(entry.key);
    patchUpload(entry.key, { state: "cancelled" });
    if (entry.videoId) {
      api(`/api/admin/upload?id=${encodeURIComponent(entry.videoId)}`, {
        method: "DELETE",
      })
        .then(load)
        .catch(() => {});
    }
  };

  const retryUpload = async (entry) => {
    if (entry.videoId) {
      try {
        await api(`/api/admin/upload?id=${encodeURIComponent(entry.videoId)}`, {
          method: "DELETE",
        });
      } catch {
        // half-created video may already be gone
      }
    }
    startUpload(entry.file, entry.key);
  };

  const onFiles = (fileList) => {
    for (const file of Array.from(fileList || [])) startUpload(file);
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return videos || [];
    return (videos || []).filter((v) => v.title.toLowerCase().includes(q));
  }, [videos, search]);

  const canReorder = !search.trim();

  const handleDragStart = (index) => () => {
    dragIndex.current = index;
  };
  const handleDragOver = (index) => (e) => {
    e.preventDefault();
    const from = dragIndex.current;
    if (from === null || from === index) return;
    setVideos((list) => {
      const next = [...list];
      const [moved] = next.splice(from, 1);
      next.splice(index, 0, moved);
      return next;
    });
    dragIndex.current = index;
  };
  const handleDrop = async () => {
    dragIndex.current = null;
    try {
      await api("/api/admin/order", {
        method: "POST",
        body: { order: videosRef.current.map((v) => v.id) },
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const saveRename = async () => {
    const { id, title } = renaming;
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      await api("/api/admin/videos", {
        method: "POST",
        body: { action: "rename", id, title: trimmed },
      });
      setRenaming(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const setCollection = async (video, collectionId) => {
    try {
      await api("/api/admin/videos", {
        method: "POST",
        body: { action: "set-collection", id: video.id, collectionId },
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const removeVideo = async (video) => {
    if (!window.confirm(`Delete "${video.title}" from bunny.net? This cannot be undone.`)) {
      return;
    }
    try {
      await api(`/api/admin/videos?id=${encodeURIComponent(video.id)}`, {
        method: "DELETE",
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const addCollection = async (e) => {
    e.preventDefault();
    const name = newCollection.trim();
    if (!name) return;
    try {
      await api("/api/admin/collections", { method: "POST", body: { name } });
      setNewCollection("");
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const removeCollection = async (collection) => {
    if (!window.confirm(`Delete the collection "${collection.name}"? Videos stay in the library.`)) {
      return;
    }
    try {
      await api(`/api/admin/collections?id=${encodeURIComponent(collection.id)}`, {
        method: "DELETE",
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="stack-lg">
      <section
        className={`card dropzone ${dragOver ? "dropzone-active" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          onFiles(e.dataTransfer.files);
        }}
      >
        <UploadIcon size={22} />
        <p>
          Drag &amp; drop video files here, or{" "}
          <button
            type="button"
            className="inline-link"
            onClick={() => fileInput.current?.click()}
          >
            browse
          </button>
          . Files upload straight from your browser to bunny.net (resumable).
        </p>
        <input
          ref={fileInput}
          type="file"
          accept="video/*"
          multiple
          hidden
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {uploads.length > 0 ? (
          <div className="upload-list">
            {uploads.map((u) => (
              <div key={u.key} className="upload-row">
                <span className="upload-name">{u.title}</span>
                {u.state === "uploading" || u.state === "creating" ? (
                  <>
                    <div className="progress-track upload-progress">
                      <div className="progress-fill" style={{ width: `${u.progress}%` }} />
                    </div>
                    <span className="muted small">{u.progress}%</span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => cancelUpload(u)}>
                      Cancel
                    </button>
                  </>
                ) : u.state === "done" ? (
                  <span className="badge badge-ok">Uploaded</span>
                ) : u.state === "cancelled" ? (
                  <span className="badge">Cancelled</span>
                ) : (
                  <>
                    <span className="badge badge-danger" title={u.error || ""}>
                      Failed
                    </span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => retryUpload(u)}>
                      Retry
                    </button>
                  </>
                )}
                {u.state !== "uploading" && u.state !== "creating" ? (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Dismiss"
                    onClick={() => setUploads((l) => l.filter((x) => x.key !== u.key))}
                  >
                    <XIcon size={13} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {error ? <div className="notice notice-error">{error}</div> : null}

      <section className="card">
        <div className="card-head">
          <h3>Library ({videos ? videos.length : "…"})</h3>
          <input
            type="search"
            className="input input-sm"
            placeholder="Filter by title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {!canReorder ? (
          <p className="muted small">Clear the filter to drag-reorder.</p>
        ) : (
          <p className="muted small">
            Drag rows to set the homepage order — new uploads float to the top
            until placed.
          </p>
        )}
        {videos === null ? (
          <p className="muted">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="muted">No videos.</p>
        ) : (
          <div className="row-list">
            {visible.map((video, index) => (
              <div
                key={video.id}
                className="row video-row"
                draggable={canReorder}
                onDragStart={handleDragStart(index)}
                onDragOver={handleDragOver(index)}
                onDrop={handleDrop}
                onDragEnd={handleDrop}
              >
                {canReorder ? (
                  <span className="grip" title="Drag to reorder">
                    <GripIcon size={14} />
                  </span>
                ) : null}
                {thumbs && video.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={video.thumbnail} alt="" className="row-thumb" />
                ) : null}
                <div className="row-main">
                  {renaming?.id === video.id ? (
                    <div className="rename-row">
                      <input
                        className="input input-sm"
                        value={renaming.title}
                        autoFocus
                        onChange={(e) =>
                          setRenaming({ ...renaming, title: e.target.value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveRename();
                          if (e.key === "Escape") setRenaming(null);
                        }}
                      />
                      <button type="button" className="btn btn-primary btn-sm" onClick={saveRename}>
                        Save
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRenaming(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <strong className="row-title">{video.title}</strong>
                      <span className="muted small">
                        {video.length ? `${formatDuration(video.length)} · ` : ""}
                        {video.views} views
                        {video.dateUploaded
                          ? ` · uploaded ${timeAgo(video.dateUploaded)}`
                          : ""}
                      </span>
                    </>
                  )}
                </div>
                <StatusBadge video={video} />
                <select
                  className="input input-sm collection-select"
                  value={video.collectionId}
                  onChange={(e) => setCollection(video, e.target.value)}
                  aria-label="Collection"
                >
                  <option value="">No collection</option>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setShareFor(video)}
                    title="Create a private share link"
                  >
                    <LinkIcon size={13} /> Share
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Rename"
                    onClick={() => setRenaming({ id: video.id, title: video.title })}
                  >
                    <PencilIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn-danger"
                    aria-label="Delete"
                    onClick={() => removeVideo(video)}
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Collections</h3>
        </div>
        <form onSubmit={addCollection} className="inline-form">
          <input
            className="input input-sm"
            placeholder="New collection name…"
            value={newCollection}
            onChange={(e) => setNewCollection(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-sm">
            Create
          </button>
        </form>
        {collections.length === 0 ? (
          <p className="muted small">No collections yet.</p>
        ) : (
          <div className="row-list">
            {collections.map((c) => (
              <div key={c.id} className="row">
                <div className="row-main">
                  <strong className="row-title">{c.name}</strong>
                  <span className="muted small">{c.videoCount} videos</span>
                </div>
                <button
                  type="button"
                  className="icon-btn icon-btn-danger"
                  aria-label={`Delete collection ${c.name}`}
                  onClick={() => removeCollection(c)}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {shareFor ? (
        <ShareCreator
          video={shareFor}
          emailConfigured={emailConfigured}
          onClose={() => setShareFor(null)}
          onCreated={onSharesChanged}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Viewers tab                                                         */
/* ------------------------------------------------------------------ */

function ViewersTab({ onCount }) {
  const [viewers, setViewers] = useState(null);
  const [input, setInput] = useState("");
  const [note, setNote] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api("/api/admin/viewers");
      setViewers(data.viewers);
      onCount(data.viewers.length);
    } catch (err) {
      setError(err.message);
    }
  }, [onCount]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async (e) => {
    e.preventDefault();
    setError("");
    setNote(null);
    try {
      const data = await api("/api/admin/viewers", {
        method: "POST",
        body: { emails: input },
      });
      const parts = [`Added ${data.added}`];
      if (data.skippedExisting) parts.push(`${data.skippedExisting} already approved`);
      if (data.invalid?.length) parts.push(`${data.invalid.length} invalid: ${data.invalid.join(", ")}`);
      setNote(parts.join(" · "));
      setInput("");
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (email) => {
    if (!window.confirm(`Remove ${email} from approved viewers?`)) return;
    try {
      await api(`/api/admin/viewers?email=${encodeURIComponent(email)}`, {
        method: "DELETE",
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="stack-lg">
      <section className="card">
        <h3>Add approved viewers</h3>
        <p className="muted small">
          Paste one or many emails — separated by commas, spaces, or new lines.
          They are validated and deduped automatically.
        </p>
        <form onSubmit={add} className="stack">
          <textarea
            className="input textarea"
            rows={3}
            placeholder={"captain@example.com\nfirstmate@example.com"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <div className="row-actions">
            <button type="submit" className="btn btn-primary" disabled={!input.trim()}>
              Add viewers
            </button>
          </div>
        </form>
        {note ? <div className="notice notice-ok">{note}</div> : null}
        {error ? <div className="notice notice-error">{error}</div> : null}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Approved viewers ({viewers ? viewers.length : "…"})</h3>
        </div>
        {viewers === null ? (
          <p className="muted">Loading…</p>
        ) : viewers.length === 0 ? (
          <p className="muted">
            No approved viewers yet — only admins can see the library.
          </p>
        ) : (
          <div className="row-list">
            {viewers.map((viewer) => (
              <div key={viewer.email} className="row">
                <div className="row-main">
                  <strong className="row-title">{viewer.email}</strong>
                  <span className="muted small">
                    Last seen {timeAgo(viewer.lastSeen)}
                    {viewer.addedAt ? ` · added ${timeAgo(viewer.addedAt)}` : ""}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-btn icon-btn-danger"
                  aria-label={`Remove ${viewer.email}`}
                  onClick={() => remove(viewer.email)}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shares tab                                                          */
/* ------------------------------------------------------------------ */

function SharesTab({ emailConfigured, onCount }) {
  const [shares, setShares] = useState(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [copiedId, setCopiedId] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api("/api/admin/shares");
      setShares(data.shares);
      onCount(data.shares.length);
    } catch (err) {
      setError(err.message);
    }
  }, [onCount]);

  useEffect(() => {
    load();
  }, [load]);

  const copy = async (share) => {
    try {
      await navigator.clipboard.writeText(share.url);
      setCopiedId(share.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setError("Could not copy the link");
    }
  };

  const sendEmail = async (share) => {
    setBusyId(share.id);
    setError("");
    try {
      await api("/api/admin/share-email", { method: "POST", body: { id: share.id } });
      await load();
    } catch (err) {
      setError(err.message);
    }
    setBusyId(null);
  };

  const revoke = async (share) => {
    if (!window.confirm(`Revoke the link for ${share.email}? It stops working immediately.`)) {
      return;
    }
    try {
      await api(`/api/admin/shares?id=${encodeURIComponent(share.id)}`, {
        method: "DELETE",
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="stack-lg">
      {error ? <div className="notice notice-error">{error}</div> : null}
      <section className="card">
        <div className="card-head">
          <h3>Active share links ({shares ? shares.length : "…"})</h3>
        </div>
        <p className="muted small">
          Private links are tied to one recipient email and require login.
          {emailConfigured
            ? " New links are emailed automatically; use Email to resend."
            : " Configure email delivery in Settings to send links automatically."}
        </p>
        {shares === null ? (
          <p className="muted">Loading…</p>
        ) : shares.length === 0 ? (
          <p className="muted">No active share links.</p>
        ) : (
          <div className="row-list">
            {shares.map((share) => (
              <div key={share.id} className="row share-row">
                <div className="row-main">
                  <strong className="row-title">{share.videoTitle}</strong>
                  <span className="muted small">
                    for {share.email} · expires in {expiresIn(share.expiresAt)}{" "}
                    ({new Date(share.expiresAt).toLocaleString()})
                  </span>
                </div>
                {share.viewedAt ? (
                  <span className="badge badge-ok" title={new Date(share.viewedAt).toLocaleString()}>
                    Viewed
                  </span>
                ) : (
                  <span className="badge">Not viewed</span>
                )}
                {share.emailedAt ? (
                  <span className="badge badge-info" title={new Date(share.emailedAt).toLocaleString()}>
                    Emailed
                  </span>
                ) : null}
                <div className="row-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(share)}>
                    {copiedId === share.id ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                    {copiedId === share.id ? " Copied" : " Copy"}
                  </button>
                  {emailConfigured ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busyId === share.id}
                      onClick={() => sendEmail(share)}
                      title={share.emailedAt ? "Resend the email" : "Email the link"}
                    >
                      <MailIcon size={13} />{" "}
                      {busyId === share.id
                        ? "Sending…"
                        : share.emailedAt
                          ? "Resend"
                          : "Email"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => revoke(share)}
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Settings tab                                                        */
/* ------------------------------------------------------------------ */

function SettingsTab({ config, onConfig }) {
  const [count, setCount] = useState(config.videoCount);
  const [theme, setTheme] = useState(null);
  const [customA, setCustomA] = useState("#38bdf8");
  const [customB, setCustomB] = useState("#818cf8");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/theme")
      .then((data) => {
        setTheme(data.theme);
        if (data.theme.preset === "custom") {
          setCustomA(data.theme.accent);
          setCustomB(data.theme.accent2);
        }
      })
      .catch(() => {});
  }, []);

  const saveCount = async (e) => {
    e.preventDefault();
    setError("");
    setNote("");
    try {
      await api("/api/admin/settings", {
        method: "POST",
        body: { videoCount: Number(count) },
      });
      onConfig({ videoCount: Number(count) });
      setNote("Saved.");
    } catch (err) {
      setError(err.message);
    }
  };

  const applyTheme = async (body) => {
    setError("");
    try {
      const data = await api("/api/theme", { method: "POST", body });
      setTheme(data.theme);
      applyResolvedTheme(data.theme);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="stack-lg">
      {error ? <div className="notice notice-error">{error}</div> : null}

      <section className="card">
        <h3>Homepage video count</h3>
        <p className="muted small">
          Hard cap on how many videos the homepage lists (enforced in code —
          bunny.net does not honor it as a strict API limit).
        </p>
        <form onSubmit={saveCount} className="inline-form">
          <input
            type="number"
            className="input input-sm"
            min="1"
            max="100"
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-sm">
            Save
          </button>
          {note ? <span className="muted small">{note}</span> : null}
        </form>
      </section>

      <section className="card">
        <h3>Color palette</h3>
        <p className="muted small">
          Applied to all visitors. Cached client-side with a pre-paint script,
          so returning visitors never see a color flicker.
        </p>
        <div className="preset-grid">
          {Object.entries(PRESETS).map(([name, preset]) => (
            <button
              key={name}
              type="button"
              className={`preset ${theme?.preset === name ? "preset-active" : ""}`}
              onClick={() => applyTheme({ preset: name })}
            >
              <span className="swatch" style={{ background: preset.accent }} />
              <span className="swatch" style={{ background: preset.accent2 }} />
              <span>{preset.label}</span>
            </button>
          ))}
        </div>
        <div className="custom-theme">
          <label className="field-inline">
            <span className="field-label">Accent</span>
            <input type="color" value={customA} onChange={(e) => setCustomA(e.target.value)} />
          </label>
          <label className="field-inline">
            <span className="field-label">Accent 2</span>
            <input type="color" value={customB} onChange={(e) => setCustomB(e.target.value)} />
          </label>
          <button
            type="button"
            className={`btn btn-sm ${theme?.preset === "custom" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => applyTheme({ preset: "custom", accent: customA, accent2: customB })}
          >
            Apply custom colors
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Share-link email delivery</h3>
        {config.emailConfigured ? (
          <div className="notice notice-ok">
            <MailIcon size={14} /> Enabled — share links are emailed to
            recipients automatically from <strong>{config.emailFrom}</strong>{" "}
            (via Resend).
          </div>
        ) : (
          <>
            <p className="muted small">
              Not configured — admins copy links and send them manually. To
              enable automatic delivery:
            </p>
            <ol className="muted small setup-list">
              <li>
                Create a free <strong>resend.com</strong> account and verify
                your sending domain.
              </li>
              <li>
                In Vercel, set <code>RESEND_API_KEY</code> and{" "}
                <code>EMAIL_FROM</code> (e.g.{" "}
                <code>Portal &lt;videos@yourdomain.com&gt;</code>), optionally{" "}
                <code>EMAIL_REPLY_TO</code>.
              </li>
              <li>Redeploy — env changes only apply to new deployments.</li>
            </ol>
          </>
        )}
      </section>

      <section className="card">
        <h3>Content protection</h3>
        <p className="muted small">
          Every play uses a signed, time-limited bunny.net embed token
          generated fresh per request — no permanent or public URL exists.
          Thumbnails are CDN token-signed and carry the site&apos;s Referer, so
          hotlink protection blocks direct/off-site access. For full lockdown,
          enable <strong>Block Direct URL File Access</strong> on the
          library&apos;s Security tab in bunny.net; the app never uses direct
          CDN file URLs, so nothing breaks.
        </p>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Activity tab                                                        */
/* ------------------------------------------------------------------ */

const ACTION_LABELS = {
  "viewer.add": "Viewer added",
  "viewer.remove": "Viewer removed",
  "share.create": "Share link created",
  "share.revoke": "Share link revoked",
  "share.email": "Share link emailed",
  "video.rename": "Video renamed",
  "video.delete": "Video deleted",
  "video.upload": "Upload started",
  "video.upload.cancel": "Upload cancelled",
  "video.collection": "Video collection changed",
  "order.update": "Library reordered",
  "settings.update": "Settings changed",
  "theme.update": "Palette changed",
  "collection.create": "Collection created",
  "collection.delete": "Collection deleted",
};

function ActivityTab() {
  const [actions, setActions] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/admin/audit")
      .then((data) => setActions(data.actions))
      .catch((err) => setError(err.message));
  }, []);

  return (
    <section className="card">
      <div className="card-head">
        <h3>Recent admin activity</h3>
      </div>
      {error ? <div className="notice notice-error">{error}</div> : null}
      {actions === null ? (
        <p className="muted">Loading…</p>
      ) : actions.length === 0 ? (
        <p className="muted">No activity recorded yet.</p>
      ) : (
        <div className="row-list">
          {actions.map((action, index) => (
            <div key={`${action.at}-${index}`} className="row audit-row">
              <div className="row-main">
                <strong className="row-title">
                  {ACTION_LABELS[action.action] || action.action}
                </strong>
                <span className="muted small">
                  {action.detail ? `${action.detail} · ` : ""}
                  by {action.actor}
                </span>
              </div>
              <span className="muted small" title={new Date(action.at).toLocaleString()}>
                {timeAgo(action.at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Analytics tab                                                       */
/* ------------------------------------------------------------------ */

function AnalyticsTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/admin/analytics")
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <div className="notice notice-error">{error}</div>;
  if (!data) return <p className="muted">Loading analytics…</p>;

  const maxValue = Math.max(1, ...data.chart.map((p) => p.value));

  return (
    <div className="stack-lg">
      <div className="stat-grid">
        <div className="card stat">
          <span className="stat-value">{data.totalViews.toLocaleString()}</span>
          <span className="muted small">Total views</span>
        </div>
        <div className="card stat">
          <span className="stat-value">{data.views30d.toLocaleString()}</span>
          <span className="muted small">Views, last 30 days</span>
        </div>
        <div className="card stat">
          <span className="stat-value">{data.watchTimeHours.toLocaleString()}h</span>
          <span className="muted small">Watch time, last 30 days</span>
        </div>
        <div className="card stat">
          <span className="stat-value">{data.videoCount.toLocaleString()}</span>
          <span className="muted small">Videos</span>
        </div>
      </div>

      {data.chart.length > 0 ? (
        <section className="card">
          <h3>Views — last 30 days</h3>
          <div className="chart">
            {data.chart.map((point) => (
              <div
                key={point.date}
                className="chart-bar"
                title={`${point.date}: ${point.value} views`}
              >
                <div
                  className="chart-fill"
                  style={{ height: `${Math.max(2, (point.value / maxValue) * 100)}%` }}
                />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="card">
        <h3>Most watched</h3>
        {data.mostWatched.length === 0 ? (
          <p className="muted">No view data yet.</p>
        ) : (
          <div className="row-list">
            {data.mostWatched.map((video, index) => (
              <div key={video.id} className="row">
                <span className="rank">{index + 1}</span>
                <div className="row-main">
                  <strong className="row-title">{video.title}</strong>
                </div>
                <span className="muted small">{video.views.toLocaleString()} views</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Admin page                                                          */
/* ------------------------------------------------------------------ */

const TABS = [
  ["videos", "Videos"],
  ["viewers", "Viewers"],
  ["shares", "Shares"],
  ["settings", "Settings"],
  ["activity", "Activity"],
  ["analytics", "Analytics"],
];

export default function Admin({ user }) {
  const [tab, setTab] = useState("videos");
  const [counts, setCounts] = useState({ viewers: null, shares: null });
  const [config, setConfig] = useState({
    videoCount: 30,
    emailConfigured: false,
    emailFrom: null,
  });

  useEffect(() => {
    api("/api/admin/settings")
      .then((data) =>
        setConfig({
          videoCount: data.videoCount,
          emailConfigured: data.emailConfigured,
          emailFrom: data.emailFrom,
        })
      )
      .catch(() => {});
    api("/api/admin/viewers")
      .then((data) => setCounts((c) => ({ ...c, viewers: data.viewers.length })))
      .catch(() => {});
    api("/api/admin/shares")
      .then((data) => setCounts((c) => ({ ...c, shares: data.shares.length })))
      .catch(() => {});
  }, []);

  const setViewerCount = useCallback(
    (n) => setCounts((c) => ({ ...c, viewers: n })),
    []
  );
  const setShareCount = useCallback(
    (n) => setCounts((c) => ({ ...c, shares: n })),
    []
  );
  const refreshShareCount = useCallback(() => {
    api("/api/admin/shares")
      .then((data) => setCounts((c) => ({ ...c, shares: data.shares.length })))
      .catch(() => {});
  }, []);

  return (
    <AppShell user={user} admin>
      <Head>
        <title>Admin — Marine Video Portal</title>
      </Head>
      <h1 className="page-title">Admin</h1>
      <div className="tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`tab ${tab === key ? "tab-active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
            {key === "viewers" && counts.viewers !== null ? (
              <span className="tab-badge">{counts.viewers}</span>
            ) : null}
            {key === "shares" && counts.shares !== null ? (
              <span className="tab-badge">{counts.shares}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "videos" ? (
        <VideosTab
          emailConfigured={config.emailConfigured}
          onSharesChanged={refreshShareCount}
        />
      ) : null}
      {tab === "viewers" ? <ViewersTab onCount={setViewerCount} /> : null}
      {tab === "shares" ? (
        <SharesTab emailConfigured={config.emailConfigured} onCount={setShareCount} />
      ) : null}
      {tab === "settings" ? (
        <SettingsTab
          config={config}
          onConfig={(patch) => setConfig((c) => ({ ...c, ...patch }))}
        />
      ) : null}
      {tab === "activity" ? <ActivityTab /> : null}
      {tab === "analytics" ? <AnalyticsTab /> : null}
    </AppShell>
  );
}
