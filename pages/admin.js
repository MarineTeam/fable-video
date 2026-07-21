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
  const [watermark, setWatermark] = useState("default");
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
          watermark,
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
            {result.bundle ? (
              <p className="muted small">
                This recipient now has multiple active links, grouped into
                one bundle page — the email links there instead of just this
                video.
              </p>
            ) : null}
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
            <label className="field">
              <span className="field-label">Watermark</span>
              <select
                className="input"
                value={watermark}
                onChange={(e) => setWatermark(e.target.value)}
              >
                <option value="default">Default (use video/global setting)</option>
                <option value="on">Always show</option>
                <option value="off">Never show</option>
              </select>
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
/* Bulk share creation                                                 */
/* ------------------------------------------------------------------ */

function BulkShareCreator({ videos, emailConfigured, onClose, onCreated }) {
  const [emailsText, setEmailsText] = useState("");
  const [hours, setHours] = useState(72);
  const [sendMail, setSendMail] = useState(emailConfigured);
  const [watermark, setWatermark] = useState("default");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [copiedBundle, setCopiedBundle] = useState(null);

  const copyBundleUrl = async (recipient, url) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedBundle(recipient);
      setTimeout(() => setCopiedBundle(null), 2000);
    } catch {
      setError("Could not copy the bundle link");
    }
  };

  const parsedEmails = useMemo(
    () =>
      Array.from(
        new Set(
          emailsText
            .split(/[\s,;\n]+/)
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean)
        )
      ),
    [emailsText]
  );

  const pairCount = videos.length * parsedEmails.length;

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api("/api/admin/share-bulk", {
        method: "POST",
        body: {
          videoIds: videos.map((v) => v.id),
          emails: parsedEmails,
          hours: Number(hours),
          sendEmail: sendMail,
          watermark,
        },
      });
      setResult(data);
      onCreated?.();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Bulk-share videos">
        <div className="modal-head">
          <h3 className="modal-title">
            Share {videos.length} video{videos.length === 1 ? "" : "s"}
          </h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <XIcon size={16} />
          </button>
        </div>
        <p className="muted small">{videos.map((v) => v.title).join(", ")}</p>

        {result ? (
          <div className="share-result stack">
            <p className="notice notice-ok">
              <LinkIcon size={14} /> Created {result.created} link
              {result.created === 1 ? "" : "s"} — {result.videos} video
              {result.videos === 1 ? "" : "s"} × {result.recipients} recipient
              {result.recipients === 1 ? "" : "s"}.
            </p>
            {sendMail && result.emailConfigured ? (
              <ul className="stack-sm">
                {Object.entries(result.emailResults).map(([recipient, r]) => (
                  <li key={recipient} className="muted small">
                    {r.emailed ? (
                      <>
                        <MailIcon size={12} /> Emailed {recipient}
                      </>
                    ) : (
                      <>
                        Could not email {recipient}: {r.error}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">
                Links were created but not emailed. Copy them from the Shares
                tab.
              </p>
            )}
            {Object.values(result.bundleResults || {}).some(Boolean) ? (
              <ul className="stack-sm">
                {Object.entries(result.bundleResults)
                  .filter(([, bundle]) => bundle)
                  .map(([recipient, bundle]) => (
                    <li key={recipient} className="muted small share-link-box">
                      <span>
                        {recipient} now has a bundle page grouping their active
                        links.
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => copyBundleUrl(recipient, bundle.url)}
                      >
                        {copiedBundle === recipient ? (
                          <CheckIcon size={13} />
                        ) : (
                          <CopyIcon size={13} />
                        )}
                        {copiedBundle === recipient ? " Copied" : " Copy bundle link"}
                      </button>
                    </li>
                  ))}
              </ul>
            ) : null}
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={create} className="stack">
            <label className="field">
              <span className="field-label">
                Recipient emails (comma, space, or newline separated)
              </span>
              <textarea
                className="input"
                rows={3}
                required
                value={emailsText}
                onChange={(e) => setEmailsText(e.target.value)}
                placeholder="alice@example.com, bob@example.com"
              />
              <span className="muted small">
                {parsedEmails.length} recipient{parsedEmails.length === 1 ? "" : "s"}
                {pairCount > 0
                  ? ` · ${pairCount} link${pairCount === 1 ? "" : "s"} will be created`
                  : ""}
              </span>
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
            <label className="field">
              <span className="field-label">Watermark</span>
              <select
                className="input"
                value={watermark}
                onChange={(e) => setWatermark(e.target.value)}
              >
                <option value="default">Default (use video/global setting)</option>
                <option value="on">Always show</option>
                <option value="off">Never show</option>
              </select>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={sendMail && emailConfigured}
                disabled={!emailConfigured}
                onChange={(e) => setSendMail(e.target.checked)}
              />
              <span>
                Email each recipient their links
                {!emailConfigured ? (
                  <span className="muted small block">
                    (email delivery isn&apos;t configured — see Settings)
                  </span>
                ) : null}
              </span>
            </label>
            {error ? <div className="notice notice-error">{error}</div> : null}
            <div className="row-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || !parsedEmails.length}
              >
                <LinkIcon size={14} />{" "}
                {busy
                  ? "Creating…"
                  : `Create ${pairCount || ""} link${pairCount === 1 ? "" : "s"}`}
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
  const [selected, setSelected] = useState(() => new Set());
  const [bulkShareOpen, setBulkShareOpen] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [newCollection, setNewCollection] = useState("");
  const [error, setError] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkReport, setBulkReport] = useState(null);
  const [bulkCollection, setBulkCollection] = useState("");
  const [shareStats, setShareStats] = useState(null);
  const [statsFor, setStatsFor] = useState(null);
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

  // Fetched once, separately from `load`'s auto-refresh cycle (which can
  // fire every 5s while a video is processing) — share stats don't change
  // that often and this avoids hammering Redis on every encoding poll.
  useEffect(() => {
    api("/api/admin/shares")
      .then((data) => {
        const map = {};
        (data.rollup || []).forEach((row) => {
          map[row.videoId] = row;
        });
        setShareStats(map);
      })
      .catch(() => {});
  }, []);

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

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedVideos = useMemo(
    () => (videos || []).filter((v) => selected.has(v.id)),
    [videos, selected]
  );

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

  const setWatermarkMode = async (video, mode) => {
    try {
      await api("/api/admin/videos", {
        method: "POST",
        body: { action: "set-watermark", id: video.id, watermark: mode },
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const bulkDelete = async () => {
    if (
      !window.confirm(
        `Delete ${selected.size} video(s) from bunny.net? This cannot be undone.`
      )
    ) {
      return;
    }
    setBulkBusy(true);
    setBulkReport(null);
    try {
      const data = await api("/api/admin/videos", {
        method: "POST",
        body: { action: "bulk-delete", ids: [...selected] },
      });
      const entries = Object.entries(data.results || {});
      const succeeded = entries.filter(([, r]) => r.ok).length;
      setBulkReport({
        action: "Deleted",
        succeeded,
        failed: entries.length - succeeded,
        errors: entries.filter(([, r]) => !r.ok),
      });
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(err.message);
    }
    setBulkBusy(false);
  };

  const bulkSetCollection = async () => {
    setBulkBusy(true);
    setBulkReport(null);
    try {
      const data = await api("/api/admin/videos", {
        method: "POST",
        body: {
          action: "bulk-set-collection",
          ids: [...selected],
          collectionId: bulkCollection,
        },
      });
      const entries = Object.entries(data.results || {});
      const succeeded = entries.filter(([, r]) => r.ok).length;
      setBulkReport({
        action: "Updated",
        succeeded,
        failed: entries.length - succeeded,
        errors: entries.filter(([, r]) => !r.ok),
      });
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(err.message);
    }
    setBulkBusy(false);
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
        {selected.size > 0 ? (
          <div className="bulk-toolbar">
            <span className="muted small">{selected.size} selected</span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setBulkShareOpen(true)}
            >
              <LinkIcon size={13} /> Share selected
            </button>
            <select
              className="input input-sm"
              value={bulkCollection}
              onChange={(e) => setBulkCollection(e.target.value)}
              aria-label="Move selected to collection"
            >
              <option value="">No collection</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={bulkBusy}
              onClick={bulkSetCollection}
            >
              {bulkBusy ? "Moving…" : "Move"}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={bulkBusy}
              onClick={bulkDelete}
            >
              {bulkBusy ? "Deleting…" : `Delete ${selected.size}`}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          </div>
        ) : null}
        {bulkReport ? (
          <p className={bulkReport.failed ? "notice notice-error" : "notice notice-ok"}>
            {bulkReport.action} {bulkReport.succeeded} video{bulkReport.succeeded === 1 ? "" : "s"}
            {bulkReport.failed
              ? `; ${bulkReport.failed} failed (${bulkReport.errors
                  .map(([, r]) => r.error)
                  .join(", ")})`
              : ""}
            .
          </p>
        ) : null}
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
              <div key={video.id} className="video-item">
              <div
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
                <input
                  type="checkbox"
                  className="row-check"
                  checked={selected.has(video.id)}
                  onChange={() => toggleSelect(video.id)}
                  aria-label={`Select ${video.title}`}
                />
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
                <select
                  className="input input-sm"
                  value={video.watermark || "default"}
                  onChange={(e) => setWatermarkMode(video, e.target.value)}
                  aria-label="Watermark"
                  title="Email watermark for this video"
                >
                  <option value="default">Watermark: default</option>
                  <option value="on">Watermark: always</option>
                  <option value="off">Watermark: never</option>
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
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      setStatsFor((cur) => (cur === video.id ? null : video.id))
                    }
                    title="Per-video share analytics"
                  >
                    {statsFor === video.id ? "Hide stats" : "Stats"}
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
              {statsFor === video.id ? (
                <div className="row video-stats-row">
                  {shareStats === null ? (
                    <p className="muted small">Loading share analytics…</p>
                  ) : shareStats[video.id] ? (
                    <span className="muted small">
                      {shareStats[video.id].shares} link
                      {shareStats[video.id].shares === 1 ? "" : "s"} ·{" "}
                      {shareStats[video.id].uniqueRecipients} recipient
                      {shareStats[video.id].uniqueRecipients === 1 ? "" : "s"} ·{" "}
                      {shareStats[video.id].views} view
                      {shareStats[video.id].views === 1 ? "" : "s"} ·{" "}
                      {shareStats[video.id].started} started ·{" "}
                      {shareStats[video.id].completed} completed (
                      {shareStats[video.id].completionRate}%) · avg{" "}
                      {shareStats[video.id].avgProgress}% watched
                    </span>
                  ) : (
                    <p className="muted small">
                      No share links for this video yet.
                    </p>
                  )}
                </div>
              ) : null}
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
      {bulkShareOpen ? (
        <BulkShareCreator
          videos={selectedVideos}
          emailConfigured={emailConfigured}
          onClose={() => setBulkShareOpen(false)}
          onCreated={() => {
            onSharesChanged?.();
            setSelected(new Set());
          }}
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

function isShareExpired(share) {
  return new Date(share.expiresAt).getTime() <= Date.now();
}

function SharesTab({ emailConfigured, onCount }) {
  const [shares, setShares] = useState(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkReport, setBulkReport] = useState(null);

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

  const copyBundleLink = async (share) => {
    try {
      const url = `${window.location.origin}/watch/bundle/${share.bundleId}`;
      await navigator.clipboard.writeText(url);
      setCopiedId(`bundle:${share.id}`);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setError("Could not copy the bundle link");
    }
  };

  // A durable, always-visible view of every recipient's bundle page — so
  // the link doesn't only exist as a one-time success message. Grouped
  // client-side from the shares list already fetched; a bundle is never a
  // second source of truth (see lib/bundles.js), so this is purely a
  // different view of the same rows.
  const bundleGroups = useMemo(() => {
    if (!shares) return [];
    const byBundle = new Map();
    shares.forEach((share) => {
      if (!share.bundleId) return;
      const group = byBundle.get(share.bundleId) || {
        bundleId: share.bundleId,
        email: share.email,
        total: 0,
        live: 0,
        soonestExpiresAt: null,
      };
      group.total += 1;
      if (!share.revoked && !isShareExpired(share)) {
        group.live += 1;
        if (!group.soonestExpiresAt || share.expiresAt < group.soonestExpiresAt) {
          group.soonestExpiresAt = share.expiresAt;
        }
      }
      byBundle.set(share.bundleId, group);
    });
    return Array.from(byBundle.values()).sort((a, b) => a.email.localeCompare(b.email));
  }, [shares]);

  const copyBundleUrlFor = async (bundleId) => {
    try {
      const url = `${window.location.origin}/watch/bundle/${bundleId}`;
      await navigator.clipboard.writeText(url);
      setCopiedId(`bundle-group:${bundleId}`);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setError("Could not copy the bundle link");
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
    if (
      !window.confirm(
        `Revoke the link for ${share.email}? It stops working immediately — you can restore it later if needed.`
      )
    ) {
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

  const restoreShare = async (share) => {
    setBusyId(share.id);
    setError("");
    try {
      await api(`/api/admin/shares?id=${encodeURIComponent(share.id)}`, {
        method: "PATCH",
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
    setBusyId(null);
  };

  const deleteForever = async (share) => {
    if (
      !window.confirm(
        `Permanently delete the revoked link for ${share.email}? This cannot be undone.`
      )
    ) {
      return;
    }
    setBusyId(share.id);
    setError("");
    try {
      await api(`/api/admin/shares?id=${encodeURIComponent(share.id)}`, {
        method: "DELETE",
        body: { permanent: true },
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
    setBusyId(null);
  };

  const promptHours = (defaultValue) => {
    const raw = window.prompt("Extend by how many hours? (max 720)", String(defaultValue));
    if (!raw) return null;
    const hours = Number(raw);
    if (!Number.isFinite(hours) || hours <= 0) {
      setError("Enter a positive number of hours");
      return null;
    }
    return hours;
  };

  const extendOne = async (share) => {
    const hours = promptHours(72);
    if (!hours) return;
    setBusyId(share.id);
    setError("");
    try {
      const data = await api("/api/admin/share-extend", {
        method: "POST",
        body: { id: share.id, hours },
      });
      const result = data.results?.[share.id];
      if (!result?.ok) throw new Error(result?.error || "Could not extend this link");
      await load();
    } catch (err) {
      setError(err.message);
    }
    setBusyId(null);
  };

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const extendSelected = async () => {
    const hours = promptHours(72);
    if (!hours) return;
    setBulkBusy(true);
    setError("");
    setBulkReport(null);
    try {
      const data = await api("/api/admin/share-extend", {
        method: "POST",
        body: { ids: [...selected], hours },
      });
      const entries = Object.entries(data.results || {});
      const succeeded = entries.filter(([, r]) => r.ok).length;
      setBulkReport({
        action: "Extended",
        succeeded,
        failed: entries.length - succeeded,
        errors: entries.filter(([, r]) => !r.ok),
      });
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(err.message);
    }
    setBulkBusy(false);
  };

  const resendSelected = async () => {
    const ids = [...selected];
    setBulkBusy(true);
    setError("");
    setBulkReport(null);
    try {
      const data = await api("/api/admin/share-email", {
        method: "POST",
        body: { ids },
      });
      // A single selected id gets the row-level {ok, emailedAt} shape
      // instead of {results}; normalize both into one report.
      const results = data.results || { [ids[0]]: { ok: true, emailedAt: data.emailedAt } };
      const entries = Object.entries(results);
      const succeeded = entries.filter(([, r]) => r.ok).length;
      setBulkReport({
        action: "Emailed",
        succeeded,
        failed: entries.length - succeeded,
        errors: entries.filter(([, r]) => !r.ok),
      });
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(err.message);
    }
    setBulkBusy(false);
  };

  const revokeSelected = async () => {
    const ids = [...selected];
    if (
      !window.confirm(
        `Revoke ${ids.length} link${ids.length === 1 ? "" : "s"}? They stop working immediately — you can restore them later if needed.`
      )
    ) {
      return;
    }
    setBulkBusy(true);
    setError("");
    setBulkReport(null);
    try {
      const data = await api("/api/admin/shares", {
        method: "DELETE",
        body: { ids },
      });
      // A single selected id gets the row-level {ok:true} shape instead of
      // {results}; normalize both into one report.
      const results = data.results || { [ids[0]]: { ok: true } };
      const entries = Object.entries(results);
      const succeeded = entries.filter(([, r]) => r.ok).length;
      setBulkReport({
        action: "Revoked",
        succeeded,
        failed: entries.length - succeeded,
        errors: entries.filter(([, r]) => !r.ok),
      });
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(err.message);
    }
    setBulkBusy(false);
  };

  return (
    <div className="stack-lg">
      {error ? <div className="notice notice-error">{error}</div> : null}
      {bundleGroups.length > 0 ? (
        <section className="card">
          <div className="card-head">
            <h3>Bundle pages ({bundleGroups.length})</h3>
          </div>
          <p className="muted small">
            One page per recipient grouping their active links — a durable
            place to grab the link again, not just at share-creation time.
          </p>
          <div className="row-list">
            {bundleGroups.map((group) => (
              <div key={group.bundleId} className="row">
                <div className="row-main">
                  <strong className="row-title">{group.email}</strong>
                  <span className="muted small">
                    {group.live} of {group.total} link{group.total === 1 ? "" : "s"} active
                    {group.soonestExpiresAt
                      ? ` · soonest expiry ${new Date(group.soonestExpiresAt).toLocaleString()}`
                      : ""}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => copyBundleUrlFor(group.bundleId)}
                >
                  {copiedId === `bundle-group:${group.bundleId}` ? (
                    <CheckIcon size={13} />
                  ) : (
                    <CopyIcon size={13} />
                  )}
                  {copiedId === `bundle-group:${group.bundleId}` ? " Copied" : " Copy bundle link"}
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <section className="card">
        <div className="card-head">
          <h3>Share links ({shares ? shares.length : "…"})</h3>
        </div>
        <p className="muted small">
          Private links are tied to one recipient email and require login.
          {emailConfigured
            ? " New links are emailed automatically; use Email to resend."
            : " Configure email delivery in Settings to send links automatically."}
          {" "}Once a recipient has 2+ active links they&apos;re grouped into
          one bundle page and one consolidated email. Revoking a link is
          recoverable — use Restore to undo it, or Delete permanently once
          you&apos;re sure.
        </p>
        {selected.size > 0 ? (
          <div className="bulk-toolbar">
            <span className="muted small">{selected.size} selected</span>
            {emailConfigured ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={bulkBusy}
                onClick={resendSelected}
              >
                {bulkBusy ? "Emailing…" : `Resend ${selected.size}`}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={bulkBusy}
              onClick={extendSelected}
            >
              {bulkBusy ? "Extending…" : "Extend selected"}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={bulkBusy}
              onClick={revokeSelected}
            >
              {bulkBusy ? "Revoking…" : `Revoke ${selected.size}`}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          </div>
        ) : null}
        {bulkReport ? (
          <p className={bulkReport.failed ? "notice notice-error" : "notice notice-ok"}>
            {bulkReport.action} {bulkReport.succeeded} link{bulkReport.succeeded === 1 ? "" : "s"}
            {bulkReport.failed
              ? `; ${bulkReport.failed} failed (${bulkReport.errors
                  .map(([id, r]) => r.error)
                  .join(", ")})`
              : ""}
            .
          </p>
        ) : null}
        {shares === null ? (
          <p className="muted">Loading…</p>
        ) : shares.length === 0 ? (
          <p className="muted">No share links.</p>
        ) : (
          <div className="row-list">
            {shares.map((share) => {
              const expired = isShareExpired(share);
              return (
                <div key={share.id} className="row share-row">
                  <input
                    type="checkbox"
                    className="row-check"
                    checked={selected.has(share.id)}
                    onChange={() => toggleSelect(share.id)}
                    aria-label={`Select the link for ${share.email}`}
                  />
                  <div className="row-main">
                    <strong className="row-title">{share.videoTitle}</strong>
                    <span className="muted small">
                      for {share.email} ·{" "}
                      {expired
                        ? "expired"
                        : `expires in ${expiresIn(share.expiresAt)}`}{" "}
                      ({new Date(share.expiresAt).toLocaleString()})
                    </span>
                  </div>
                  {share.revoked ? (
                    <span className="badge badge-danger" title={share.revokedAt ? `Revoked ${new Date(share.revokedAt).toLocaleString()}` : undefined}>
                      Revoked
                    </span>
                  ) : expired ? (
                    <span className="badge badge-danger">Expired</span>
                  ) : null}
                  {share.bundleId ? (
                    <span className="badge badge-info" title="Grouped into this recipient's bundle page">
                      Bundled
                    </span>
                  ) : null}
                  {share.viewCount ? (
                    <span
                      className="badge badge-ok"
                      title={`Last opened ${new Date(share.lastViewedAt).toLocaleString()}`}
                    >
                      Viewed {share.viewCount}×
                    </span>
                  ) : (
                    <span className="badge">Not viewed</span>
                  )}
                  {share.playCount ? (
                    <span
                      className="badge badge-info"
                      title={`${share.playCount} playback(s) started`}
                    >
                      Played {share.playCount}×
                    </span>
                  ) : null}
                  {share.completedAt ? (
                    <span
                      className="badge badge-ok"
                      title={`Completed ${new Date(share.completedAt).toLocaleString()}`}
                    >
                      Completed
                    </span>
                  ) : share.furthestPercent ? (
                    <span className="badge" title="Furthest point reached in playback">
                      {share.furthestPercent}% watched
                    </span>
                  ) : null}
                  {share.emailedAt ? (
                    <span className="badge badge-info" title={new Date(share.emailedAt).toLocaleString()}>
                      Emailed
                    </span>
                  ) : null}
                  <div className="row-actions">
                    {share.revoked ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={busyId === share.id}
                          onClick={() => restoreShare(share)}
                          title="Undo the revoke — same link, same URL, no re-notification"
                        >
                          {busyId === share.id ? "Restoring…" : "Restore"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={busyId === share.id}
                          onClick={() => deleteForever(share)}
                        >
                          Delete permanently
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(share)}>
                          {copiedId === share.id ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                          {copiedId === share.id ? " Copied" : " Copy"}
                        </button>
                        {share.bundleId ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => copyBundleLink(share)}
                            title="Copy this recipient's bundle page link"
                          >
                            {copiedId === `bundle:${share.id}` ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                            {copiedId === `bundle:${share.id}` ? " Copied" : " Copy bundle"}
                          </button>
                        ) : null}
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
                          className="btn btn-ghost btn-sm"
                          disabled={busyId === share.id}
                          onClick={() => extendOne(share)}
                          title="Extend this link's expiry in place — same URL, no re-notification"
                        >
                          {busyId === share.id ? "Extending…" : "Extend"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          onClick={() => revoke(share)}
                          title="Revoke this link — recoverable via Restore until it's permanently deleted"
                        >
                          Revoke
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
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
  const [pushTitle, setPushTitle] = useState("");
  const [pushBody, setPushBody] = useState("");
  const [pushNote, setPushNote] = useState("");
  const [watermarkEnabled, setWatermarkEnabled] = useState(config.watermarkEnabled);
  const [watermarkNote, setWatermarkNote] = useState("");
  const [exemptions, setExemptions] = useState(null);
  const [exemptInput, setExemptInput] = useState("");
  const [exemptError, setExemptError] = useState("");

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

  useEffect(() => {
    api("/api/admin/watermark-exempt")
      .then((data) => setExemptions(data.exemptions))
      .catch(() => {});
  }, []);

  const toggleWatermark = async (enabled) => {
    setError("");
    setWatermarkNote("");
    try {
      await api("/api/admin/settings", {
        method: "POST",
        body: { watermarkEnabled: enabled },
      });
      setWatermarkEnabled(enabled);
      onConfig({ watermarkEnabled: enabled });
      setWatermarkNote("Saved.");
    } catch (err) {
      setError(err.message);
    }
  };

  const addExemption = async (e) => {
    e.preventDefault();
    setExemptError("");
    const email = exemptInput.trim().toLowerCase();
    if (!email) return;
    try {
      await api("/api/admin/watermark-exempt", {
        method: "POST",
        body: { email },
      });
      setExemptInput("");
      const data = await api("/api/admin/watermark-exempt");
      setExemptions(data.exemptions);
    } catch (err) {
      setExemptError(err.message);
    }
  };

  const removeExemption = async (email) => {
    try {
      await api(`/api/admin/watermark-exempt?email=${encodeURIComponent(email)}`, {
        method: "DELETE",
      });
      setExemptions((list) => (list || []).filter((e) => e !== email));
    } catch (err) {
      setExemptError(err.message);
    }
  };

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

  const sendBroadcast = async (e) => {
    e.preventDefault();
    setError("");
    setPushNote("");
    try {
      const data = await api("/api/admin/notify", {
        method: "POST",
        body: { title: pushTitle, body: pushBody },
      });
      setPushNote(`Sent to ${data.sent} device(s).`);
      setPushTitle("");
      setPushBody("");
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
        <h3>Email watermark</h3>
        <p className="muted small">
          Overlays the viewer&apos;s email on playback as a deterrent against
          re-sharing. Resolved per play, most specific wins: an exempted
          viewer never sees one; otherwise a per-share Always/Never choice
          (set when the link was created) wins next; then a per-video
          override (in the Videos tab); otherwise this global default
          applies.
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={Boolean(watermarkEnabled)}
            onChange={(e) => toggleWatermark(e.target.checked)}
          />
          <span>Enabled by default for all playback</span>
        </label>
        {watermarkNote ? <span className="muted small">{watermarkNote}</span> : null}

        <h3 style={{ marginTop: "1.2rem" }}>Exempt from watermark</h3>
        <p className="muted small">
          These emails (viewers or admins) never see a watermark, regardless
          of any other setting.
        </p>
        <form onSubmit={addExemption} className="inline-form">
          <input
            type="email"
            className="input input-sm"
            placeholder="person@example.com"
            value={exemptInput}
            onChange={(e) => setExemptInput(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-sm">
            Exempt
          </button>
        </form>
        {exemptError ? <div className="notice notice-error">{exemptError}</div> : null}
        {exemptions === null ? (
          <p className="muted small">Loading…</p>
        ) : exemptions.length === 0 ? (
          <p className="muted small">No exemptions.</p>
        ) : (
          <div className="row-list">
            {exemptions.map((email) => (
              <div key={email} className="row">
                <div className="row-main">
                  <strong className="row-title">{email}</strong>
                </div>
                <button
                  type="button"
                  className="icon-btn icon-btn-danger"
                  aria-label={`Remove exemption for ${email}`}
                  onClick={() => removeExemption(email)}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
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
        <h3>Broadcast notification</h3>
        {config.pushConfigured ? (
          <>
            <p className="muted small">
              Push a notification to everyone who has enabled notifications
              (approved viewers and admins). New videos are announced
              automatically — use this for anything else.
            </p>
            <form onSubmit={sendBroadcast}>
              <input
                type="text"
                className="input"
                placeholder="Title"
                maxLength={100}
                value={pushTitle}
                onChange={(e) => setPushTitle(e.target.value)}
                required
                style={{ marginBottom: 8 }}
              />
              <textarea
                className="input"
                placeholder="Message (optional)"
                maxLength={300}
                rows={2}
                value={pushBody}
                onChange={(e) => setPushBody(e.target.value)}
                style={{ marginBottom: 8 }}
              />
              <div className="inline-form">
                <button type="submit" className="btn btn-primary btn-sm">
                  Send broadcast
                </button>
                {pushNote ? <span className="muted small">{pushNote}</span> : null}
              </div>
            </form>
          </>
        ) : (
          <p className="muted small">
            Not configured — generate a key pair with{" "}
            <code>npx web-push generate-vapid-keys</code>, set{" "}
            <code>NEXT_PUBLIC_VAPID_PUBLIC_KEY</code> and{" "}
            <code>VAPID_PRIVATE_KEY</code> in Vercel, and redeploy.
          </p>
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
  "share.bulk_create": "Bulk share links created",
  "share.extend": "Share link(s) extended",
  "share.revoke": "Share link revoked",
  "share.unrevoke": "Share link restored",
  "share.delete": "Share link permanently deleted",
  "share.email": "Share link emailed",
  "video.rename": "Video renamed",
  "video.delete": "Video deleted",
  "video.upload": "Upload started",
  "video.upload.cancel": "Upload cancelled",
  "video.collection": "Video collection changed",
  "video.watermark": "Video watermark setting changed",
  "video.bulk_delete": "Videos bulk-deleted",
  "video.bulk_collection": "Videos bulk-moved to a collection",
  "order.update": "Library reordered",
  "settings.update": "Settings changed",
  "push.broadcast": "Notification broadcast",
  "theme.update": "Palette changed",
  "collection.create": "Collection created",
  "collection.delete": "Collection deleted",
  "watermark.exempt_add": "Watermark exemption added",
  "watermark.exempt_remove": "Watermark exemption removed",
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

      {data.shareRollup && data.shareRollup.length > 0 ? (
        <section className="card">
          <details>
            <summary className="collapsible-summary">
              <strong>Per-video share analytics</strong>
              <span className="muted small">
                {" "}
                — {data.shareRollup.length} video
                {data.shareRollup.length === 1 ? "" : "s"} with share links
              </span>
            </summary>
            <p className="muted small" style={{ marginTop: "0.6rem" }}>
              Rolled up from existing share-link tracking (opens, playback
              starts, completions) — no new data is collected.
            </p>
            <div className="row-list">
              {data.shareRollup.map((row) => (
                <div key={row.videoId} className="row">
                  <div className="row-main">
                    <strong className="row-title">{row.videoTitle}</strong>
                    <span className="muted small">
                      {row.shares} link{row.shares === 1 ? "" : "s"} ·{" "}
                      {row.uniqueRecipients} recipient
                      {row.uniqueRecipients === 1 ? "" : "s"} · {row.views} view
                      {row.views === 1 ? "" : "s"} · {row.started} started ·{" "}
                      {row.completed} completed ({row.completionRate}%) · avg{" "}
                      {row.avgProgress}% watched
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </details>
        </section>
      ) : null}
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
    pushConfigured: false,
    watermarkEnabled: false,
  });

  useEffect(() => {
    api("/api/admin/settings")
      .then((data) =>
        setConfig({
          videoCount: data.videoCount,
          emailConfigured: data.emailConfigured,
          emailFrom: data.emailFrom,
          pushConfigured: data.pushConfigured,
          watermarkEnabled: data.watermarkEnabled,
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
    <AppShell user={user} admin canNotify>
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
