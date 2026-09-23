// Tabbed admin panel: Videos / Viewers / Groups / Shares / Settings /
// Activity / Analytics. Gated server-side (anyone without a staff role is
// redirected before any admin UI is sent); every /api/admin/* route
// independently re-checks its own capability and returns 403 as well.
//
// Which tabs render is driven by the caller's capabilities, so a manager
// never sees the People or Settings tabs. That is a convenience, NOT the
// authorization boundary — the routes behind those tabs are what actually
// enforce it.
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
import { blockedByEmailVerification, normalizeEmail } from "../lib/auth";
// CAP comes from the storage-free policy module: pages/admin.js is a client
// component, and lib/roles.js reaches into Redis.
import { ALL_CAPABILITIES, CAP } from "../lib/capabilities";
import { pageTitle } from "../lib/siteName";
import { MAX_NOTES_LENGTH } from "../lib/notes";
import { formatChapters, parseChapters } from "../lib/chapters";
import { sameChapters } from "../lib/aiChapters";
import { resolveAccess } from "../lib/roles";
import { PRESETS } from "../lib/theme";
import { applyResolvedTheme } from "../lib/theme-client";
import { getSiteName } from "../lib/store";
import { withMonitorPage } from "../lib/monitor";
import { resetMonitorCalls } from "../lib/monitorClient";

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
  if (blockedByEmailVerification(session.user)) {
    return { redirect: { destination: "/", permanent: false } };
  }
  const access = await resolveAccess(email);
  if (!access.staff) {
    return { redirect: { destination: "/", permanent: false } };
  }
  const siteName = await getSiteName().catch(() => null);
  return {
    props: {
      user: { email, name: session.user.name || email },
      admin: true,
      owner: access.owner,
      capabilities: access.capabilities,
      siteName,
    },
  };
}

export const getServerSideProps = withMonitorPage(gssp);

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

// Viewers can't see a video outside its window; staff always can. The badge
// is what tells an admin why a video they can see isn't in the library.
function ScheduleBadge({ video }) {
  if (video.scheduleState === "scheduled") {
    return (
      <span className="badge" title={`Publishes ${video.schedule?.publishAt}`}>
        Scheduled
      </span>
    );
  }
  if (video.scheduleState === "expired") {
    return (
      <span className="badge badge-danger" title={`Expired ${video.schedule?.expiresAt}`}>
        Expired
      </span>
    );
  }
  return null;
}

// datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time; the API stores UTC
// ISO strings. These two convert between them without dragging in a date
// library.
function toLocalInput(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Transcription for one video, inside the details modal because a transcript
// is the third per-video text feature alongside chapters and notes.
//
// THE PRICE IS ON THE BUTTON, deliberately. bunny bills $0.10 per minute of
// video, so a 90-minute service is $9 — the kind of number an admin should
// read before clicking, not discover on an invoice. Re-transcribing is a
// second charge for the same minutes, so it is a separate, explicitly
// labelled action rather than the same button pressed twice.
//
// Two steps, not one, because bunny's transcription is asynchronous: queueing
// returns immediately and the captions appear minutes later, so "Fetch" is
// what pulls them in. Hiding that behind a poller would hide the timing too.
function TranscriptControls({ video }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  // Opt-in, and unticked by default: chapter suggestions ride along with the
  // same job at no extra charge, but a video whose chapters are already typed
  // has no use for them. Nothing they produce is ever saved automatically.
  const [wantChapters, setWantChapters] = useState(false);

  const post = async (body, pending) => {
    setBusy(true);
    setError("");
    setStatus(pending);
    try {
      const result = await api("/api/admin/transcribe", {
        method: "POST",
        body: { guid: video.id, ...body },
      });
      if (result?.queued) {
        setStatus(
          result.chapters
            ? "Queued with chapter suggestions. bunny takes a few minutes; then press Fetch, and Suggest chapters above."
            : "Queued. bunny takes a few minutes; then press Fetch."
        );
      } else if (result?.ready) {
        setStatus(`Fetched ${result.cues} lines (${result.language}).`);
      } else {
        setStatus("Not ready yet — give it another minute, then press Fetch.");
      }
    } catch (err) {
      setError(err?.message || "That did not work.");
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-sm">
      <span className="muted small">
        Transcript — bunny.net transcribes the audio, then viewers get a
        searchable transcript under the player. Costs about{" "}
        <strong>$0.10 per minute</strong> of video, charged by bunny.
      </span>
      <div className="row-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => post({ chapters: wantChapters }, "Queueing…")}
        >
          Transcribe
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => post({ ingest: true }, "Fetching…")}
        >
          Fetch captions
        </button>
      </div>
      <label className="row-check">
        <input
          type="checkbox"
          checked={wantChapters}
          disabled={busy}
          onChange={(e) => setWantChapters(e.target.checked)}
        />
        <span className="muted small">
          Also suggest chapters from the transcript. Suggestions are never saved
          for you — they load into the box above for you to accept or edit.
        </span>
      </label>
      {status ? <div className="notice notice-ok">{status}</div> : null}
      {error ? <div className="notice notice-error">{error}</div> : null}
    </div>
  );
}

// Chapters and sermon notes for one video. Both are stored per video and are
// additive — a video with neither behaves exactly as it did before these
// existed. The textarea is the source of truth; the SERVER parses it
// (lib/chapters.js) and reports back which lines it could not read, so a
// typo is surfaced here rather than silently dropped.
function DetailsEditor({ video, onClose, onSaved }) {
  const [chapterText, setChapterText] = useState(formatChapters(video.chapters));
  const [notes, setNotes] = useState(video.notes || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ignored, setIgnored] = useState([]);
  const [late, setLate] = useState([]);
  const [saved, setSaved] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState("");

  // Loads bunny's generated chapters INTO THE TEXTAREA. This is the accept
  // step, and it is deliberately only half of one: the suggestions sit in the
  // box until the admin presses Save, so the stored list is still something a
  // person chose. Replacing text the admin typed asks first — the AI is not
  // allowed to overwrite someone's work on a single click.
  const suggest = async () => {
    setSuggesting(true);
    setError("");
    setSuggestion("");
    try {
      const result = await api("/api/admin/transcribe", {
        method: "POST",
        body: { guid: video.id, suggestions: true },
      });
      const proposed = result?.chapters || [];
      const skipped = result?.ignored || [];
      if (!proposed.length) {
        setSuggestion(
          skipped.length
            ? `bunny returned ${skipped.length} chapter(s) that could not be read. Nothing to load.`
            : "bunny has not generated chapters for this video. Transcribe again with the chapters box ticked."
        );
        return;
      }
      if (sameChapters(parseChapters(chapterText).chapters, proposed)) {
        setSuggestion("The suggestions match what is already here — nothing to change.");
        return;
      }
      if (
        chapterText.trim() &&
        !window.confirm(
          `Replace the ${parseChapters(chapterText).chapters.length} chapter(s) in the box with ${proposed.length} suggested one(s)? Nothing is saved until you press Save.`
        )
      ) {
        return;
      }
      setChapterText(formatChapters(proposed));
      setSuggestion(
        `Loaded ${proposed.length} suggestion(s)${
          skipped.length ? `, skipped ${skipped.length}` : ""
        }. Edit what you like, then press Save — nothing is stored until you do.`
      );
    } catch (err) {
      setError(err?.message || "Could not read the suggestions.");
    } finally {
      setSuggesting(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await api("/api/admin/videos", {
        method: "POST",
        body: {
          action: "set-chapters",
          id: video.id,
          text: chapterText,
          // Named durationSeconds rather than length: see lib/params.js —
          // `length` collides with the built-in property on the server.
          durationSeconds: video.length || 0,
        },
      });
      await api("/api/admin/videos", {
        method: "POST",
        body: { action: "set-notes", id: video.id, text: notes },
      });
      setIgnored(result?.ignored || []);
      setLate(result?.beyondDuration || []);
      setChapterText(formatChapters(result?.chapters || []));
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Chapters and notes"
      >
        <div className="modal-head">
          <h3 className="modal-title">Chapters &amp; notes</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <XIcon size={14} />
          </button>
        </div>
        <p className="muted small">
          Viewers see these under the player on <strong>{video.title}</strong>.
          Leave both empty for no chapters and no notes.
        </p>
        <label className="stack-sm">
          <span className="muted small">
            Chapters — one per line, timestamp first: <code>24:15 Sermon</code>.
            M:SS, MM:SS and H:MM:SS all work; they are sorted for you on save.
          </span>
          <textarea
            className="input textarea chapters-help"
            rows={8}
            value={chapterText}
            onChange={(e) => setChapterText(e.target.value)}
            placeholder={"0:00 Worship\n18:30 Announcements\n24:15 Sermon"}
          />
        </label>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={suggesting || busy}
            onClick={suggest}
          >
            {suggesting ? "Reading…" : "Suggest chapters"}
          </button>
          <span className="muted small">
            From the transcript, if one was generated with chapters. Loads into
            the box above — never saved for you.
          </span>
        </div>
        {suggestion ? <div className="notice notice-ok">{suggestion}</div> : null}
        <label className="stack-sm">
          <span className="muted small">
            Notes — an outline or the passage covered. Searchable from the
            library. {notes.length}/{MAX_NOTES_LENGTH} characters.
          </span>
          <textarea
            className="input textarea"
            rows={6}
            maxLength={MAX_NOTES_LENGTH}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Philippians 4:10-20 — contentment and provision."
          />
        </label>
        <TranscriptControls video={video} />
        {error ? <div className="notice notice-error">{error}</div> : null}
        {ignored.length ? (
          <div className="notice notice-warn notice-block">
            Skipped {ignored.length} line{ignored.length === 1 ? "" : "s"} that
            did not start with a timestamp:
            <ul>
              {ignored.map((entry) => (
                <li key={entry.line}>
                  Line {entry.line}: &ldquo;{entry.text}&rdquo; — {entry.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {late.length ? (
          <div className="notice notice-warn">
            Saved, but {late.join(", ")} {late.length === 1 ? "is" : "are"} past
            the end of this recording.
          </div>
        ) : null}
        {saved && !ignored.length && !late.length ? (
          <div className="notice notice-ok">Saved.</div>
        ) : null}
        <div className="row-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
            Save
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// Turns one video's public (no-login) link on or off. Deliberately a
// confirm-then-act dialog rather than an inline toggle in the row: this is
// the only control in the panel that makes something reachable by anyone on
// the internet, and it should be harder to hit by accident than a checkbox
// sitting next to "Rename".
function PublicLinkEditor({ video, onClose, onSaved }) {
  const [isPublic, setIsPublic] = useState(Boolean(video.public));
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!video.public) return;
    api("/api/admin/public-videos")
      .then((data) => {
        const row = (data?.videos || []).find((v) => v.id === video.id);
        setUrl(row?.url || "");
      })
      .catch(() => {});
  }, [video.id, video.public]);

  const save = async (next) => {
    setBusy(true);
    setError("");
    try {
      const result = await api("/api/admin/public-videos", {
        method: "POST",
        body: { id: video.id, public: next },
      });
      setIsPublic(next);
      setUrl(result?.url || "");
      onSaved();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard blocked — the address is on screen to copy by hand.
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Public link"
      >
        <div className="modal-head">
          <h3 className="modal-title">Public link</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <XIcon size={14} />
          </button>
        </div>
        <p className="muted small">
          Makes <strong>{video.title}</strong> watchable by anyone who has the
          address, with no account and no sign-in. Everything else stays
          private — the page shows this one video and nothing about the rest
          of the library.
        </p>
        <div className="notice notice-block">
          Still applies: the publish/expiry window, and a fresh signed
          playback token per view. Not applied: watermarks, resume position,
          and any per-viewer record — there is no viewer to attribute. The
          page asks search engines not to index it, but anyone the address is
          forwarded to can watch.
        </div>
        {error ? <div className="notice notice-error">{error}</div> : null}
        {isPublic ? (
          <>
            {url ? (
              <label className="stack-sm">
                <span className="muted small">Anyone with this address can watch</span>
                <input className="input" readOnly value={url} onFocus={(e) => e.target.select()} />
              </label>
            ) : (
              <div className="notice notice-warn notice-block">
                Public, but <strong>APP_BASE_URL</strong> is not configured, so
                the address can&apos;t be shown here.
              </div>
            )}
            <div className="row-actions">
              {url ? (
                <button type="button" className="btn btn-ghost" onClick={copy}>
                  {copied ? "Copied" : "Copy link"}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => save(false)}
              >
                Turn off public link
              </button>
            </div>
          </>
        ) : (
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => save(true)}
            >
              Make this video public
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ScheduleEditor({ video, onClose, onSaved }) {
  const [publishAt, setPublishAt] = useState(toLocalInput(video.schedule?.publishAt));
  const [expiresAt, setExpiresAt] = useState(toLocalInput(video.schedule?.expiresAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async (clear) => {
    setBusy(true);
    setError("");
    try {
      await api("/api/admin/videos", {
        method: "POST",
        body: {
          action: "set-schedule",
          id: video.id,
          publishAt: clear ? null : fromLocalInput(publishAt),
          expiresAt: clear ? null : fromLocalInput(expiresAt),
        },
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Schedule"
      >
        <div className="modal-head">
          <h3 className="modal-title">Schedule</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <XIcon size={14} />
          </button>
        </div>
        <p className="muted small">
          Controls when <strong>{video.title}</strong> is visible to viewers.
          Leave a field empty for no limit. Admins and managers always see it,
          so you can still find and preview it here.
        </p>
        <label className="stack-sm">
          <span className="muted small">Publish at</span>
          <input
            type="datetime-local"
            className="input"
            value={publishAt}
            onChange={(e) => setPublishAt(e.target.value)}
          />
        </label>
        <label className="stack-sm">
          <span className="muted small">Expires at</span>
          <input
            type="datetime-local"
            className="input"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </label>
        {error ? <div className="notice notice-error">{error}</div> : null}
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => save(false)}
          >
            Save schedule
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || (!publishAt && !expiresAt)}
            onClick={() => save(true)}
          >
            Always available
          </button>
        </div>
      </div>
    </div>
  );
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

function ShareCreator({ video, viewers, emailConfigured, onClose, onCreated }) {
  const [emailsText, setEmailsText] = useState("");
  const [hours, setHours] = useState(72);
  const [sendMail, setSendMail] = useState(emailConfigured);
  const [watermark, setWatermark] = useState("default");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [copiedBundle, setCopiedBundle] = useState(null);
  const [groupTag, setGroupTag] = useState("");

  const availableTags = useMemo(
    () => Array.from(new Set((viewers || []).flatMap((v) => v.tags || []))).sort(),
    [viewers]
  );

  const addGroup = () => {
    if (!groupTag) return;
    const emails = (viewers || [])
      .filter((v) => (v.tags || []).includes(groupTag))
      .map((v) => v.email);
    if (!emails.length) return;
    setEmailsText((prev) =>
      Array.from(
        new Set(
          [...prev.split(/[\s,;\n]+/).map((e) => e.trim()).filter(Boolean), ...emails]
        )
      ).join(", ")
    );
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

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api("/api/admin/share-bulk", {
        method: "POST",
        body: {
          videoIds: [video.id],
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

  const copyBundleUrl = async (recipient, url) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedBundle(recipient);
      setTimeout(() => setCopiedBundle(null), 2000);
    } catch {
      setError("Could not copy the bundle link");
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
          <div className="share-result stack">
            <p className="notice notice-ok">
              <LinkIcon size={14} /> Created {result.created} link
              {result.created === 1 ? "" : "s"} for {result.recipients} recipient
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
            {availableTags.length > 0 ? (
              <label className="field">
                <span className="field-label">Add a viewer group</span>
                <div className="row-actions">
                  <select
                    className="input input-sm"
                    value={groupTag}
                    onChange={(e) => setGroupTag(e.target.value)}
                    aria-label="Viewer group"
                  >
                    <option value="">Choose a tag…</option>
                    {availableTags.map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={!groupTag}
                    onClick={addGroup}
                  >
                    Add group&apos;s emails
                  </button>
                </div>
              </label>
            ) : null}
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
                Email each recipient their link
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
                  : `Create ${parsedEmails.length || ""} link${parsedEmails.length === 1 ? "" : "s"}`}
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

function BulkShareCreator({ videos, viewers, emailConfigured, onClose, onCreated }) {
  const [emailsText, setEmailsText] = useState("");
  const [hours, setHours] = useState(72);
  const [sendMail, setSendMail] = useState(emailConfigured);
  const [watermark, setWatermark] = useState("default");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [copiedBundle, setCopiedBundle] = useState(null);
  const [groupTag, setGroupTag] = useState("");

  const availableTags = useMemo(
    () => Array.from(new Set((viewers || []).flatMap((v) => v.tags || []))).sort(),
    [viewers]
  );

  const addGroup = () => {
    if (!groupTag) return;
    const emails = (viewers || [])
      .filter((v) => (v.tags || []).includes(groupTag))
      .map((v) => v.email);
    if (!emails.length) return;
    setEmailsText((prev) =>
      Array.from(
        new Set(
          [...prev.split(/[\s,;\n]+/).map((e) => e.trim()).filter(Boolean), ...emails]
        )
      ).join(", ")
    );
  };

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
            {availableTags.length > 0 ? (
              <label className="field">
                <span className="field-label">Add a viewer group</span>
                <div className="row-actions">
                  <select
                    className="input input-sm"
                    value={groupTag}
                    onChange={(e) => setGroupTag(e.target.value)}
                    aria-label="Viewer group"
                  >
                    <option value="">Choose a tag…</option>
                    {availableTags.map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={!groupTag}
                    onClick={addGroup}
                  >
                    Add group&apos;s emails
                  </button>
                </div>
              </label>
            ) : null}
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
/* Private list — persistent per-video invite management               */
/* ------------------------------------------------------------------ */

function PrivateListManager({ video, viewers, emailConfigured, onClose, onChanged }) {
  const [entries, setEntries] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [emailsText, setEmailsText] = useState("");
  const [hours, setHours] = useState(72);
  const [sendMail, setSendMail] = useState(emailConfigured);
  const [watermark, setWatermark] = useState("default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [addResult, setAddResult] = useState(null);
  const [removingEmail, setRemovingEmail] = useState(null);
  const [groupTag, setGroupTag] = useState("");

  const availableTags = useMemo(
    () => Array.from(new Set((viewers || []).flatMap((v) => v.tags || []))).sort(),
    [viewers]
  );

  const addGroup = () => {
    if (!groupTag) return;
    const emails = (viewers || [])
      .filter((v) => (v.tags || []).includes(groupTag))
      .map((v) => v.email);
    if (!emails.length) return;
    setEmailsText((prev) =>
      Array.from(
        new Set(
          [...prev.split(/[\s,;\n]+/).map((e) => e.trim()).filter(Boolean), ...emails]
        )
      ).join(", ")
    );
  };

  const load = useCallback(async () => {
    try {
      const data = await api(
        `/api/admin/video-shares?videoId=${encodeURIComponent(video.id)}`
      );
      setEntries(data.entries);
      setLoadError("");
    } catch (err) {
      setLoadError(err.message);
    }
  }, [video.id]);

  useEffect(() => {
    load();
  }, [load]);

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

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setAddResult(null);
    try {
      const data = await api("/api/admin/video-shares", {
        method: "POST",
        body: {
          videoId: video.id,
          emails: parsedEmails,
          hours: Number(hours),
          sendEmail: sendMail,
          watermark,
        },
      });
      setAddResult(data);
      setEmailsText("");
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  const remove = async (entry) => {
    if (
      !window.confirm(
        `Remove ${entry.email} from this video's private list? Their access stops immediately.`
      )
    ) {
      return;
    }
    setRemovingEmail(entry.email);
    setError("");
    try {
      await api(
        `/api/admin/video-shares?videoId=${encodeURIComponent(video.id)}&email=${encodeURIComponent(entry.email)}`,
        { method: "DELETE" }
      );
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
    setRemovingEmail(null);
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Private list">
        <div className="modal-head">
          <h3 className="modal-title">Private list</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <XIcon size={16} />
          </button>
        </div>
        <p className="muted small">{video.title}</p>
        <p className="muted small">
          Only people added here — a link made from the Share or Bulk share
          button for the same person and video is separate and isn&apos;t
          shown or affected by Remove below.
        </p>

        <div className="stack">
          {loadError ? <div className="notice notice-error">{loadError}</div> : null}
          {entries === null ? (
            <p className="muted small">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="muted small">Nobody has been added to this video&apos;s list yet.</p>
          ) : (
            <div className="row-list">
              {entries.map((entry) => (
                <div key={entry.email} className="row">
                  <div className="row-main">
                    <strong className="row-title">{entry.email}</strong>
                    <span className="muted small">
                      Added {new Date(entry.createdAt).toLocaleDateString()} · expires{" "}
                      {new Date(entry.expiresAt).toLocaleString()}
                      {entry.emailedAt ? " · emailed" : ""}
                      {entry.viewCount ? ` · viewed ${entry.viewCount}×` : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={removingEmail === entry.email}
                    onClick={() => remove(entry)}
                  >
                    {removingEmail === entry.email ? "Removing…" : "Remove"}
                  </button>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={add} className="stack">
            {availableTags.length > 0 ? (
              <label className="field">
                <span className="field-label">Add a viewer group</span>
                <div className="row-actions">
                  <select
                    className="input input-sm"
                    value={groupTag}
                    onChange={(e) => setGroupTag(e.target.value)}
                    aria-label="Viewer group"
                  >
                    <option value="">Choose a tag…</option>
                    {availableTags.map((tag) => (
                      <option key={tag} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={!groupTag}
                    onClick={addGroup}
                  >
                    Add group&apos;s emails
                  </button>
                </div>
              </label>
            ) : null}
            <label className="field">
              <span className="field-label">
                Add people (comma, space, or newline separated)
              </span>
              <textarea
                className="input"
                rows={2}
                required
                value={emailsText}
                onChange={(e) => setEmailsText(e.target.value)}
                placeholder="alice@example.com, bob@example.com"
              />
              <span className="muted small">
                {parsedEmails.length} email{parsedEmails.length === 1 ? "" : "s"}
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
                Notify new people by email
                {!emailConfigured ? (
                  <span className="muted small block">
                    (email delivery isn&apos;t configured — see Settings)
                  </span>
                ) : null}
              </span>
            </label>
            {error ? <div className="notice notice-error">{error}</div> : null}
            {addResult ? (
              <p className="muted small">
                Added {addResult.added.length}
                {addResult.skipped.length
                  ? ` (${addResult.skipped.length} already on the list, untouched)`
                  : ""}
                .
              </p>
            ) : null}
            <div className="row-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || !parsedEmails.length}
              >
                {busy ? "Adding…" : "Add to list"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Videos tab                                                          */
/* ------------------------------------------------------------------ */

function VideosTab({ emailConfigured, onSharesChanged, canPublish, canGrantGroups }) {
  const [videos, setVideos] = useState(null);
  const [thumbs, setThumbs] = useState(false);
  const [collections, setCollections] = useState([]);
  const [viewers, setViewers] = useState([]);
  const [search, setSearch] = useState("");
  const [uploads, setUploads] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [shareFor, setShareFor] = useState(null);
  const [privateListFor, setPrivateListFor] = useState(null);
  const [scheduleFor, setScheduleFor] = useState(null);
  const [detailsFor, setDetailsFor] = useState(null);
  const [publicFor, setPublicFor] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkShareOpen, setBulkShareOpen] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [newCollection, setNewCollection] = useState("");
  const [error, setError] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkReport, setBulkReport] = useState(null);
  const [bulkCollection, setBulkCollection] = useState("");
  // The upload card's "also visible to" groups. Applies to every file dropped
  // while ticked; starts empty on every visit, deliberately — see
  // lib/uploadGrants.js on why there is no remembered default.
  const [grantGroups, setGrantGroups] = useState([]);
  const [uploadGroups, setUploadGroups] = useState([]);
  const [recounting, setRecounting] = useState(false);
  const [recountNote, setRecountNote] = useState("");
  const [shareStats, setShareStats] = useState(null);
  const [statsFor, setStatsFor] = useState(null);
  const dragIndex = useRef(null);
  const fileInput = useRef(null);
  const tusUploads = useRef(new Map());
  const videosRef = useRef([]);

  useEffect(() => {
    videosRef.current = videos || [];
  }, [videos]);

  // Group names for the upload card's picker. Only fetched for someone who
  // may grant groups — /api/admin/groups refuses anyone else, and the upload
  // route refuses their groupIds independently.
  useEffect(() => {
    if (!canGrantGroups) return;
    api("/api/admin/groups")
      .then((data) => setGrantGroups(data.groups || []))
      .catch(() => setGrantGroups([]));
  }, [canGrantGroups]);

  const load = useCallback(async () => {
    try {
      const [v, c, viewersData] = await Promise.all([
        api("/api/admin/videos"),
        api("/api/admin/collections"),
        // Minimal projection — enough to resolve a group into recipient
        // addresses, and readable by a manager who has no people access.
        api("/api/admin/viewers?scope=recipients"),
      ]);
      setVideos(v.videos);
      setThumbs(v.thumbnails);
      setCollections(c.collections);
      setViewers(viewersData.viewers);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  // Rebuilds the thumbs-up/down totals from the votes themselves. New votes
  // cannot drift any more (one Redis script writes a vote and its counters),
  // so this is for totals written before that — see
  // pages/api/admin/rating-recount.js.
  const recountRatings = async () => {
    setRecounting(true);
    setError("");
    setRecountNote("");
    try {
      const data = await api("/api/admin/rating-recount", { method: "POST" });
      setRecountNote(
        `Recounted ${data.votes} vote${data.votes === 1 ? "" : "s"} from ${data.viewers} viewer${data.viewers === 1 ? "" : "s"}.`
      );
      await load();
    } catch (err) {
      setError(err.message);
    }
    setRecounting(false);
  };

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
          // groupIds only when something is ticked, so an ordinary upload is
          // the exact request it always was.
          body: uploadGroups.length ? { title, groupIds: uploadGroups } : { title },
        });
        const failedGroups = created.groups?.failed || [];
        if (failedGroups.length) {
          patchUpload(key, {
            warning: `Not added to ${failedGroups
              .map((id) => grantGroups.find((g) => g.id === id)?.name || id)
              .join(", ")} — add it on the Groups tab.`,
          });
        }
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
    [load, uploadGroups, grantGroups]
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

  const shareCollection = (collection) => {
    const ids = new Set(
      (videos || [])
        .filter((v) => v.collectionId === collection.id)
        .map((v) => v.id)
    );
    if (!ids.size) return;
    setSelected(ids);
    setBulkShareOpen(true);
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
        {grantGroups.length > 0 ? (
          <fieldset className="upload-groups">
            <legend className="muted small">
              Also visible to groups (optional — applies to files dropped while ticked)
            </legend>
            {grantGroups.map((g) => (
              <label key={g.id} className="upload-group">
                <input
                  type="checkbox"
                  checked={uploadGroups.includes(g.id)}
                  onChange={(e) =>
                    setUploadGroups((prev) =>
                      e.target.checked ? [...prev, g.id] : prev.filter((id) => id !== g.id)
                    )
                  }
                />
                {g.name}
                {g.restricted ? null : <span className="muted small"> (sees everything)</span>}
              </label>
            ))}
          </fieldset>
        ) : null}
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
                <span className="upload-name">
                  {u.title}
                  {u.warning ? <span className="upload-warning small"> {u.warning}</span> : null}
                </span>
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
          {canPublish ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={recounting}
              onClick={recountRatings}
              title="Rebuild the thumbs-up/down totals from the votes themselves"
            >
              {recounting ? "Recounting…" : "Recount ratings"}
            </button>
          ) : null}
        </div>
        {recountNote ? <div className="notice notice-ok">{recountNote}</div> : null}
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
                <ScheduleBadge video={video} />
                {video.public ? (
                  <span
                    className="badge badge-warn"
                    title="Anyone with the link can watch this without signing in"
                  >
                    Public
                  </span>
                ) : null}
                {/* Totals only, and staff-only. The counters hold no
                    identities, so this cannot say who rated what — see
                    lib/ratings.js for why that is the design. */}
                {video.rating ? (
                  <span
                    className="badge"
                    title={`${video.rating.up} up, ${video.rating.down} down, from ${video.rating.total} viewer(s)`}
                  >
                    👍 {video.rating.up} · 👎 {video.rating.down}
                  </span>
                ) : null}
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
                    onClick={() => setPrivateListFor(video)}
                    title="Manage who has private access to this video"
                  >
                    Private list
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
                    className="btn btn-ghost btn-sm"
                    onClick={() => setScheduleFor(video)}
                    title="Schedule when viewers can see this video"
                  >
                    Schedule
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setDetailsFor(video)}
                    title="Chapters and sermon notes for this video"
                  >
                    {video.chapters?.length || video.notes ? "Chapters ✓" : "Chapters"}
                  </button>
                  {canPublish ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setPublicFor(video)}
                      title="Public link — anyone with the address, no sign-in"
                    >
                      Public link
                    </button>
                  ) : null}
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
                  className="btn btn-ghost btn-sm"
                  disabled={!c.videoCount}
                  onClick={() => shareCollection(c)}
                  title={`Share all ${c.videoCount} video(s) in this collection`}
                >
                  <LinkIcon size={13} /> Share collection
                </button>
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
          viewers={viewers}
          emailConfigured={emailConfigured}
          onClose={() => setShareFor(null)}
          onCreated={onSharesChanged}
        />
      ) : null}
      {bulkShareOpen ? (
        <BulkShareCreator
          videos={selectedVideos}
          viewers={viewers}
          emailConfigured={emailConfigured}
          onClose={() => setBulkShareOpen(false)}
          onCreated={() => {
            onSharesChanged?.();
            setSelected(new Set());
          }}
        />
      ) : null}
      {privateListFor ? (
        <PrivateListManager
          video={privateListFor}
          viewers={viewers}
          emailConfigured={emailConfigured}
          onClose={() => setPrivateListFor(null)}
          onChanged={onSharesChanged}
        />
      ) : null}
      {scheduleFor ? (
        <ScheduleEditor
          video={scheduleFor}
          onClose={() => setScheduleFor(null)}
          onSaved={load}
        />
      ) : null}
      {detailsFor ? (
        <DetailsEditor
          video={detailsFor}
          onClose={() => setDetailsFor(null)}
          onSaved={load}
        />
      ) : null}
      {publicFor ? (
        <PublicLinkEditor
          video={publicFor}
          onClose={() => setPublicFor(null)}
          onSaved={load}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Viewers tab                                                         */
/* ------------------------------------------------------------------ */

// Roles are admin-defined now, so there is no fixed label table — names come
// from the catalog the Viewers route ships alongside the people list.
function roleNames(roleIds, roles) {
  const byId = Object.fromEntries((roles || []).map((r) => [r.id, r.name]));
  return (roleIds || []).map((id) => byId[id]).filter(Boolean);
}

// The self-serve access-request queue. Lives in the Viewers tab because
// approving one is just "add this viewer" with provenance attached.
function AccessRequests({ onChanged }) {
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      setRequests((await api("/api/admin/access-requests")).requests);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (email, decision) => {
    setBusy(email);
    setError("");
    try {
      await api("/api/admin/access-requests", {
        method: "POST",
        body: { email, decision },
      });
      await load();
      if (decision === "approve") onChanged();
    } catch (err) {
      setError(err.message);
    }
    setBusy(null);
  };

  const dismiss = async (email) => {
    setBusy(email);
    setError("");
    try {
      await api(
        `/api/admin/access-requests?email=${encodeURIComponent(email)}`,
        { method: "DELETE" }
      );
      await load();
    } catch (err) {
      setError(err.message);
    }
    setBusy(null);
  };

  const pending = (requests || []).filter((r) => r.status === "pending");
  const decided = (requests || []).filter((r) => r.status !== "pending");

  if (requests !== null && requests.length === 0) return null;

  return (
    <section className="card">
      <div className="card-head">
        <h3>Access requests{pending.length ? ` (${pending.length})` : ""}</h3>
      </div>
      {error ? <div className="notice notice-error">{error}</div> : null}
      {requests === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="row-list">
          {[...pending, ...decided].map((request) => (
            <div key={request.email} className="row">
              <div className="row-main">
                <strong className="row-title">{request.email}</strong>
                <span className="muted small">
                  Asked {timeAgo(request.requestedAt)}
                  {request.status === "denied"
                    ? ` · denied ${timeAgo(request.decidedAt)}${
                        request.decidedBy ? ` by ${request.decidedBy}` : ""
                      }`
                    : ""}
                </span>
                {request.message ? (
                  <span className="muted small">
                    &ldquo;{request.message}&rdquo;
                  </span>
                ) : null}
              </div>
              {request.status === "pending" ? (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy === request.email}
                    onClick={() => decide(request.email, "approve")}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy === request.email}
                    onClick={() => decide(request.email, "deny")}
                  >
                    Deny
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy === request.email}
                  title="Remove this record so they can ask again"
                  onClick={() => dismiss(request.email)}
                >
                  Dismiss
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ViewersTab({ onCount, me }) {
  const [viewers, setViewers] = useState(null);
  const [input, setInput] = useState("");
  const [note, setNote] = useState(null);
  const [error, setError] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [editingTags, setEditingTags] = useState(null);
  const [tagInput, setTagInput] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [roleBusy, setRoleBusy] = useState(null);
  const [roles, setRoles] = useState([]);
  const [rolesFor, setRolesFor] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api("/api/admin/viewers");
      setViewers(data.viewers);
      // The role catalog rides along with the people list so the chips can
      // show names rather than ids without a second request.
      setRoles(data.roles || []);
      onCount(data.viewers.length);
    } catch (err) {
      setError(err.message);
    }
  }, [onCount]);

  useEffect(() => {
    load();
  }, [load]);

  const allTags = useMemo(
    () =>
      Array.from(new Set((viewers || []).flatMap((v) => v.tags || []))).sort(),
    [viewers]
  );

  const visibleViewers = useMemo(() => {
    if (!tagFilter) return viewers || [];
    return (viewers || []).filter((v) => (v.tags || []).includes(tagFilter));
  }, [viewers, tagFilter]);

  const startEditTags = (viewer) => {
    setEditingTags(viewer.email);
    setTagInput((viewer.tags || []).join(", "));
  };

  const saveTags = async (email) => {
    setTagBusy(true);
    setError("");
    try {
      const tags = Array.from(
        new Set(
          tagInput
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        )
      );
      await api("/api/admin/viewers", {
        method: "PATCH",
        body: { email, tags },
      });
      setEditingTags(null);
      load();
    } catch (err) {
      setError(err.message);
    }
    setTagBusy(false);
  };

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

  const assignRoles = async (email, roleIds) => {
    setRoleBusy(email);
    setError("");
    try {
      await api("/api/admin/roles", {
        method: "PATCH",
        body: { email, roleIds },
      });
      load();
    } catch (err) {
      // A 403 here is the no-escalation ceiling talking: the actor tried to
      // grant or strip something outside their own set. Show which.
      setError(err.message);
    }
    setRoleBusy(null);
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
      <AccessRequests onChanged={load} />

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
          {allTags.length > 0 ? (
            <select
              className="input input-sm"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              aria-label="Filter by tag"
            >
              <option value="">All tags</option>
              {allTags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {viewers === null ? (
          <p className="muted">Loading…</p>
        ) : viewers.length === 0 ? (
          <p className="muted">
            No approved viewers yet — only admins can see the library.
          </p>
        ) : visibleViewers.length === 0 ? (
          <p className="muted">No viewers tagged &quot;{tagFilter}&quot;.</p>
        ) : (
          <div className="row-list">
            {visibleViewers.map((viewer) => (
              <div key={viewer.email} className="row">
                <div className="row-main">
                  <strong className="row-title">{viewer.email}</strong>
                  <span className="muted small">
                    Last seen {timeAgo(viewer.lastSeen)}
                    {viewer.addedAt ? ` · added ${timeAgo(viewer.addedAt)}` : ""}
                    {viewer.onViewerList === false
                      ? " · not on the viewer list (access comes from their role)"
                      : ""}
                  </span>
                  {editingTags === viewer.email ? (
                    <div className="row-actions" style={{ marginTop: "0.4rem" }}>
                      <input
                        className="input input-sm"
                        value={tagInput}
                        placeholder="Team A, Team B"
                        onChange={(e) => setTagInput(e.target.value)}
                        aria-label={`Tags for ${viewer.email}`}
                      />
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={tagBusy}
                        onClick={() => saveTags(viewer.email)}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setEditingTags(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (viewer.tags || []).length > 0 ? (
                    <span className="muted small">
                      {(viewer.tags || []).map((tag) => (
                        <span key={tag} className="tag-chip">
                          {tag}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </div>
                {editingTags === viewer.email ? null : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => startEditTags(viewer)}
                  >
                    Edit tags
                  </button>
                )}
                {viewer.envAdmin ? (
                  <span
                    className="tag-chip"
                    title="Owner via the ADMIN_EMAILS environment variable — holds every capability and can't be changed here"
                  >
                    Owner (env)
                  </span>
                ) : (
                  <>
                    {roleNames(viewer.roleIds, roles).map((name) => (
                      <span key={name} className="tag-chip">
                        {name}
                      </span>
                    ))}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={roleBusy === viewer.email}
                      onClick={() => setRolesFor(viewer)}
                      title="Assign roles to this person"
                    >
                      {viewer.roleIds?.length ? "Edit roles" : "Assign roles"}
                    </button>
                  </>
                )}
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
      {rolesFor ? (
        <RoleAssigner
          viewer={rolesFor}
          roles={roles}
          busy={roleBusy === rolesFor.email}
          onClose={() => setRolesFor(null)}
          onSave={async (roleIds) => {
            await assignRoles(rolesFor.email, roleIds);
            setRolesFor(null);
          }}
        />
      ) : null}
    </div>
  );
}

// Assigns any number of roles to one person. A checkbox list rather than a
// dropdown because capabilities are the union of every role held — the old
// single-select could not express that.
function RoleAssigner({ viewer, roles, busy, onClose, onSave }) {
  const [selected, setSelected] = useState(new Set(viewer.roleIds || []));

  const toggle = (id) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Assign roles"
      >
        <div className="modal-head">
          <h3 className="modal-title">Roles for {viewer.email}</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <XIcon size={14} />
          </button>
        </div>
        {roles.length === 0 ? (
          <p className="muted small">
            No roles exist yet. Create one on the <strong>Roles</strong> tab first.
          </p>
        ) : (
          <>
            <p className="muted small">
              Someone holding several roles gets the union of what those roles
              allow. Holding any role at all grants access to the library.
            </p>
            <div className="stack-sm">
              {roles.map((role) => (
                <label key={role.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={selected.has(role.id)}
                    onChange={() => toggle(role.id)}
                  />
                  <span>
                    {role.name}{" "}
                    <span className="muted small">
                      ({role.capabilities.length} capabilit
                      {role.capabilities.length === 1 ? "y" : "ies"})
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || roles.length === 0}
            onClick={() => onSave([...selected])}
          >
            Save roles
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Roles tab                                                           */
/* ------------------------------------------------------------------ */

// Creates and edits roles out of the capability catalog the server ships.
//
// The catalog is server-authored on purpose: an admin cannot invent a
// capability string here, because one that names no enforcement point would
// read as though it granted something while granting nothing.
//
// Checkboxes outside the actor's own capability set are DISABLED rather than
// hidden, with a reason. The server refuses those edits anyway
// (undelegatableCapabilities), but a greyed box that explains itself beats a
// 403 after clicking Save — and hiding them would make a delegated role
// manager think the catalog is smaller than it is.
function RolesTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const result = await api("/api/admin/roles");
      setData(result);
      if (result.migrated?.migrated) {
        setNote(
          `Carried ${result.migrated.migrated} person(s) over from the old ` +
            `role system into: ${result.migrated.roles.join(", ")}.`
        );
      }
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const held = useMemo(
    () => new Set(data?.actor?.capabilities || []),
    [data]
  );

  const save = async (role) => {
    setBusy(true);
    setError("");
    try {
      await api("/api/admin/roles", {
        method: role.id ? "PUT" : "POST",
        body: { id: role.id, name: role.name, capabilities: role.capabilities },
      });
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  const remove = async (role) => {
    if (!window.confirm(`Delete the role "${role.name}"? Anyone holding it loses it.`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/admin/roles?id=${encodeURIComponent(role.id)}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  if (!data) {
    return (
      <div className="stack">
        {error ? <div className="notice notice-error">{error}</div> : null}
        {!error ? <p className="muted small">Loading…</p> : null}
      </div>
    );
  }

  const holdersOf = (roleId) =>
    Object.entries(data.assignments || {})
      .filter(([, ids]) => ids.includes(roleId))
      .map(([email]) => email);

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h3>Roles</h3>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || data.roles.length >= data.maxRoles}
            onClick={() => setEditing({ id: null, name: "", capabilities: [] })}
          >
            New role
          </button>
        </div>
        <p className="muted small">
          A role is a named set of capabilities. People can hold several and
          get the union. Holding any role grants access to the library.{" "}
          {data.actor.owner ? (
            <>
              You are an <strong>owner</strong> (via <code>ADMIN_EMAILS</code>), so you
              hold every capability and can grant any of them.
            </>
          ) : (
            <>
              You can only grant capabilities you hold yourself — the rest are
              greyed out.
            </>
          )}
        </p>
        {note ? <div className="notice notice-ok">{note}</div> : null}
        {data.legacyRemaining ? (
          <div className="notice notice-warn notice-block">
            {data.legacyRemaining} assignment(s) from the old role system are
            still stored. They keep working, and reloading this tab converts
            them.
          </div>
        ) : null}
        {error ? <div className="notice notice-error">{error}</div> : null}
        {data.roles.length === 0 ? (
          <p className="muted small">
            No roles yet. Owners still have full access, so nothing is locked —
            create a role to delegate part of it.
          </p>
        ) : (
          <div className="row-list">
            {data.roles.map((role) => {
              const outside = role.capabilities.some((cap) => !held.has(cap));
              const holders = holdersOf(role.id);
              return (
                <div key={role.id} className="row">
                  <div className="row-main">
                    <strong className="row-title">{role.name}</strong>
                    <span className="muted small">
                      {role.capabilities.length} capabilit
                      {role.capabilities.length === 1 ? "y" : "ies"}
                      {holders.length
                        ? ` · held by ${holders.length} ${holders.length === 1 ? "person" : "people"}`
                        : " · held by nobody"}
                    </span>
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy || outside}
                      title={
                        outside
                          ? "This role holds capabilities you don't have, so you can't edit it"
                          : "Edit this role"
                      }
                      onClick={() => setEditing({ ...role })}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="icon-btn icon-btn-danger"
                      aria-label={`Delete ${role.name}`}
                      disabled={busy || outside}
                      onClick={() => remove(role)}
                    >
                      <TrashIcon size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
      {editing ? (
        <RoleEditor
          role={editing}
          catalog={data.catalog}
          held={held}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      ) : null}
    </div>
  );
}

function RoleEditor({ role, catalog, held, busy, onClose, onSave }) {
  const [name, setName] = useState(role.name || "");
  const [selected, setSelected] = useState(new Set(role.capabilities || []));

  const toggle = (cap) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return next;
    });
  };

  const groups = useMemo(() => {
    const out = new Map();
    for (const entry of catalog) {
      if (!out.has(entry.group)) out.set(entry.group, []);
      out.get(entry.group).push(entry);
    }
    return [...out.entries()];
  }, [catalog]);

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={role.id ? "Edit role" : "New role"}
      >
        <div className="modal-head">
          <h3 className="modal-title">{role.id ? "Edit role" : "New role"}</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <XIcon size={14} />
          </button>
        </div>
        <label className="stack-sm">
          <span className="muted small">Name</span>
          <input
            className="input"
            value={name}
            maxLength={60}
            placeholder="Media team"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {groups.map(([group, entries]) => (
          <div key={group} className="stack-sm">
            <span className="muted small">{group}</span>
            {entries.map((entry) => {
              const blocked = !held.has(entry.cap);
              return (
                <label
                  key={entry.cap}
                  className="check-row"
                  title={blocked ? "You don't hold this capability, so you can't grant it" : undefined}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(entry.cap)}
                    disabled={blocked}
                    onChange={() => toggle(entry.cap)}
                  />
                  <span className={blocked ? "muted" : undefined}>{entry.label}</span>
                </label>
              );
            })}
          </div>
        ))}
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !name.trim()}
            onClick={() => onSave({ id: role.id, name, capabilities: [...selected] })}
          >
            {role.id ? "Save role" : "Create role"}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
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

  // Counts driven purely off the same shares/bundleGroups already fetched —
  // no extra request needed just to show what cleanup would remove.
  const staleShareCount = useMemo(
    () => (shares || []).filter((s) => s.revoked || isShareExpired(s)).length,
    [shares]
  );
  const staleBundleCount = useMemo(
    () => bundleGroups.filter((g) => g.live === 0).length,
    [bundleGroups]
  );

  const cleanupStale = async () => {
    if (staleShareCount === 0 && staleBundleCount === 0) return;
    if (
      !window.confirm(
        `Permanently delete ${staleShareCount} expired/revoked link(s)` +
          (staleBundleCount
            ? ` and ${staleBundleCount} empty bundle page(s)`
            : "") +
          `? This cannot be undone.`
      )
    ) {
      return;
    }
    setBulkBusy(true);
    setError("");
    setBulkReport(null);
    try {
      const data = await api("/api/admin/cleanup", { method: "POST" });
      setBulkReport({
        action: "Cleaned up",
        succeeded: data.deletedShares + data.deletedBundles,
        failed: 0,
        errors: [],
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
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={bulkBusy || (staleShareCount === 0 && staleBundleCount === 0)}
            onClick={cleanupStale}
            title="Permanently delete expired/revoked links and empty bundle pages instead of waiting out their 30-day grace window"
          >
            {bulkBusy
              ? "Cleaning up…"
              : staleShareCount + staleBundleCount === 0
                ? "Nothing to clean up"
                : `Clean up ${staleShareCount + staleBundleCount} stale item${
                    staleShareCount + staleBundleCount === 1 ? "" : "s"
                  }`}
          </button>
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
                      for {share.email} · created{" "}
                      {new Date(share.createdAt).toLocaleString()} ·{" "}
                      {expired
                        ? "expired"
                        : `expires in ${expiresIn(share.expiresAt)}`}{" "}
                      ({new Date(share.expiresAt).toLocaleString()})
                      {share.bundleId ? " · part of a bundle" : ""}
                      {share.privateList ? " · via Private list" : ""}
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
  const [siteNameInput, setSiteNameInput] = useState(config.siteName || "");
  const [siteNameNote, setSiteNameNote] = useState("");
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
  const [podcastEnabled, setPodcastEnabled] = useState(config.podcastEnabled);
  const [podcastNote, setPodcastNote] = useState("");
  const [exemptions, setExemptions] = useState(null);
  const [exemptInput, setExemptInput] = useState("");
  const [exemptError, setExemptError] = useState("");
  const [geoEnabled, setGeoEnabled] = useState(config.geoEnabled);
  const [geoNote, setGeoNote] = useState("");
  const [adminGeoEnabled, setAdminGeoEnabled] = useState(config.adminGeoEnabled);
  const [adminGeoNote, setAdminGeoNote] = useState("");

  // config arrives asynchronously in Admin's own effect, so seed the field
  // when it lands rather than leaving it stuck on the initial empty value.
  useEffect(() => {
    setSiteNameInput(config.siteName || "");
  }, [config.siteName]);

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

  const saveSiteNameSetting = async (e) => {
    e.preventDefault();
    setError("");
    setSiteNameNote("");
    try {
      const name = siteNameInput.trim();
      await api("/api/admin/settings", {
        method: "POST",
        body: { siteName: name },
      });
      onConfig({ siteName: name });
      setSiteNameNote("Saved — reload to see it everywhere.");
    } catch (err) {
      setError(err.message);
    }
  };

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

  const togglePodcast = async (enabled) => {
    setError("");
    setPodcastNote("");
    try {
      await api("/api/admin/settings", {
        method: "POST",
        body: { podcastEnabled: enabled },
      });
      setPodcastEnabled(enabled);
      onConfig({ podcastEnabled: enabled });
      setPodcastNote("Saved.");
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

  const toggleGeo = async (enabled) => {
    setError("");
    setGeoNote("");
    try {
      await api("/api/admin/settings", {
        method: "POST",
        body: { geoEnabled: enabled },
      });
      setGeoEnabled(enabled);
      onConfig({ geoEnabled: enabled });
      setGeoNote("Saved.");
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleAdminGeo = async (enabled) => {
    setError("");
    setAdminGeoNote("");
    try {
      await api("/api/admin/settings", {
        method: "POST",
        body: { adminGeoEnabled: enabled },
      });
      setAdminGeoEnabled(enabled);
      onConfig({ adminGeoEnabled: enabled });
      setAdminGeoNote("Saved.");
    } catch (err) {
      setError(err.message);
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
        <h3>Site name</h3>
        <p className="muted small">
          Shown in the header, every page title, and share emails. Applies to
          all visitors immediately — no redeploy.
          {config.envSiteName
            ? ` Clearing it isn't allowed; the SITE_NAME environment variable is set to "${config.envSiteName}", which is used only until a name is set here.`
            : ""}
        </p>
        <form onSubmit={saveSiteNameSetting} className="inline-form">
          <input
            type="text"
            className="input input-sm"
            maxLength={config.maxSiteNameLength || 60}
            placeholder="Marine Video Portal"
            value={siteNameInput}
            onChange={(e) => setSiteNameInput(e.target.value)}
            aria-label="Site name"
          />
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={!siteNameInput.trim()}
          >
            Save
          </button>
          {siteNameNote ? (
            <span className="muted small">{siteNameNote}</span>
          ) : null}
        </form>
      </section>

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
        <h3>Podcast feed</h3>
        <p className="muted small">
          Gives each viewer a private feed address they can paste into a
          podcast app. The address identifies the account and nothing more —
          approval, group restrictions and publish windows are re-checked on
          every fetch, so removing someone ends their feed on the next poll
          with no separate step. Off by default: unlike a schedule or a
          group, this widens how the library can be reached.
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={Boolean(podcastEnabled)}
            onChange={(e) => togglePodcast(e.target.checked)}
          />
          <span>Serve per-subscriber podcast feeds</span>
        </label>
        {podcastNote ? <span className="muted small">{podcastNote}</span> : null}
        {!config.podcastMediaReady ? (
          <div className="notice notice-warn notice-block">
            <strong>BUNNY_CDN_HOSTNAME is not set</strong>, so feeds will
            contain no episodes. The feed serves media from the CDN pull zone.
          </div>
        ) : null}
        <div className="notice notice-warn notice-block">
          bunny.net has no audio-only format, so episodes are{" "}
          <strong>{config.podcastMp4Height || 720}p video MP4s</strong> — they
          play in podcast apps but are a much bigger download than audio.
          They also require <strong>MP4 Fallback</strong> to be enabled under
          your bunny.net library&apos;s Encoding settings, and bunny.net only
          generates an MP4 for videos uploaded <em>after</em> that was turned
          on — older recordings need re-uploading or their episodes will fail
          to download.
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
        <h3>Geo-location whitelist</h3>
        <p className="muted small">
          Restricts the entire site — including login — to visitors from the
          countries listed in the <code>GEO_WHITELIST</code> env var.
          Enforced at the network boundary using Vercel&apos;s request
          geolocation, so it only takes effect when deployed on Vercel; local
          dev and non-Vercel hosts are left unrestricted. A blocked visitor
          sees a generic &quot;not available in your region&quot; page. Both
          lists below are set via env vars (Vercel → Settings → Environment
          Variables → redeploy) rather than here, so an admin can always fix
          their own access without depending on the app itself being
          reachable.
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={Boolean(geoEnabled)}
            onChange={(e) => toggleGeo(e.target.checked)}
          />
          <span>
            Enforce <code>GEO_WHITELIST</code>
          </span>
        </label>
        {geoNote ? <span className="muted small">{geoNote}</span> : null}
        <p className="muted small" style={{ marginTop: "0.4rem" }}>
          {config.geoWhitelist?.length
            ? config.geoWhitelist.join(", ")
            : "GEO_WHITELIST is not set."}
        </p>

        <h3 style={{ marginTop: "1.2rem" }}>Admin bypass whitelist</h3>
        <p className="muted small">
          A visitor from a country in <code>ADMIN_GEO_WHITELIST</code> always
          gets through, regardless of the whitelist above. This is a safety
          valve so an admin traveling somewhere <code>GEO_WHITELIST</code>{" "}
          doesn&apos;t cover isn&apos;t locked out of the whole site — add
          the current country to <code>ADMIN_GEO_WHITELIST</code> in Vercel
          and redeploy; it works even if the site is currently blocking you.
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={Boolean(adminGeoEnabled)}
            onChange={(e) => toggleAdminGeo(e.target.checked)}
          />
          <span>
            Enforce <code>ADMIN_GEO_WHITELIST</code> bypass
          </span>
        </label>
        {adminGeoNote ? <span className="muted small">{adminGeoNote}</span> : null}
        <p className="muted small" style={{ marginTop: "0.4rem" }}>
          {config.adminGeoWhitelist?.length
            ? config.adminGeoWhitelist.join(", ")
            : "ADMIN_GEO_WHITELIST is not set."}
        </p>

        <h3 style={{ marginTop: "1.2rem" }}>Admin bypass emails</h3>
        <p className="muted small">
          A signed-in visitor whose email is in{" "}
          <code>ADMIN_GEO_BYPASS_EMAILS</code> always gets through, no matter
          the country and regardless of both toggles above — no enable
          checkbox, being on the list is enough. Unlike the whitelists above,
          this doesn&apos;t require knowing your destination country ahead of
          time, so it&apos;s meant to be armed once, before traveling, as a
          standing safety net rather than something fixed in the moment
          (changes still need a Vercel redeploy to take effect).
        </p>
        <p className="muted small" style={{ marginTop: "0.4rem" }}>
          {config.adminGeoBypassEmails?.length
            ? config.adminGeoBypassEmails.join(", ")
            : "ADMIN_GEO_BYPASS_EMAILS is not set."}
        </p>
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
/* Groups tab                                                          */
/* ------------------------------------------------------------------ */

// A group restricts its members to an explicit list of videos. Membership is
// still the viewer's tag (edited in the Viewers tab) — this tab owns the
// group record and its allowlist. A group left unrestricted is a plain
// label, which is what every pre-existing tag is.
function GroupsTab() {
  const [groups, setGroups] = useState(null);
  const [untracked, setUntracked] = useState([]);
  const [videos, setVideos] = useState([]);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({ restricted: false, videoIds: [] });
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  // Membership editing is a separate capability from managing the group
  // record (see pages/api/admin/groups.js). The server decides; this only
  // hides an editor that would 403 anyway.
  const [canEditMembers, setCanEditMembers] = useState(false);
  const [collections, setCollections] = useState([]);
  const [membersFor, setMembersFor] = useState(null); // group id
  const [memberDraft, setMemberDraft] = useState("");
  const [memberNote, setMemberNote] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api("/api/admin/groups");
      setGroups(data.groups);
      setCanEditMembers(Boolean(data.canEditMembers));
      setUntracked(data.untrackedTags || []);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    api("/api/admin/videos")
      .then((data) => setVideos(data.videos || []))
      .catch(() => {});
    api("/api/admin/collections")
      .then((data) => setCollections(data.collections || []))
      .catch(() => {});
  }, [load]);

  const startEdit = (group) => {
    setEditing(group.id);
    setDraft({
      restricted: group.restricted,
      videoIds: [...(group.videoIds || [])],
      collectionIds: [...(group.collectionIds || [])],
    });
    setSearch("");
    setError("");
    setNote("");
  };

  const openMembers = (group) => {
    setMemberNote("");
    setMemberDraft("");
    setMembersFor(membersFor === group.id ? null : group.id);
  };

  // Adds or removes several people at once. The server answers with what
  // actually happened to each address, and ALL of it is shown — an admin who
  // pastes twelve addresses and gets "saved" has no way to discover that three
  // were typos until someone complains they cannot see anything.
  const changeMembers = async (group, { add = [], remove = [] }) => {
    setBusy(true);
    setError("");
    setMemberNote("");
    try {
      const result = await api("/api/admin/groups", {
        method: "PATCH",
        body: { name: group.name, add, remove },
      });
      const parts = [];
      if (result.added?.length) parts.push(`added ${result.added.length}`);
      if (result.removed?.length) parts.push(`removed ${result.removed.length}`);
      if (result.noop?.length) parts.push(`${result.noop.length} already as asked`);
      if (result.unknown?.length) {
        parts.push(`not approved viewers: ${result.unknown.join(", ")}`);
      }
      if (result.overflow?.length) {
        parts.push(`at the tag limit: ${result.overflow.join(", ")}`);
      }
      if (result.failed?.length) parts.push(`could not change: ${result.failed.join(", ")}`);
      setMemberNote(parts.length ? parts.join(" · ") : "Nothing changed.");
      setMemberDraft("");
      load();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  const toggleCollection = (id) => {
    setDraft((d) => ({
      ...d,
      collectionIds: d.collectionIds.includes(id)
        ? d.collectionIds.filter((c) => c !== id)
        : [...d.collectionIds, id],
    }));
  };

  const toggleVideo = (id) => {
    setDraft((d) => ({
      ...d,
      videoIds: d.videoIds.includes(id)
        ? d.videoIds.filter((v) => v !== id)
        : [...d.videoIds, id],
    }));
  };

  const save = async (name) => {
    setBusy(true);
    setError("");
    try {
      await api("/api/admin/groups", {
        method: "PUT",
        body: {
          name,
          restricted: draft.restricted,
          videoIds: draft.videoIds,
          collectionIds: draft.collectionIds,
        },
      });
      setEditing(null);
      setNote(`Saved "${name}".`);
      load();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  const create = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/admin/groups", {
        method: "PUT",
        body: { name, restricted: false, videoIds: [] },
      });
      setNewName("");
      setNote(`Created "${name}". Tag viewers with it from the Viewers tab.`);
      load();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  const remove = async (group) => {
    if (
      !window.confirm(
        `Delete the group "${group.name}"? Its members keep the tag, but it stops restricting what they can watch.`
      )
    ) {
      return;
    }
    try {
      await api(`/api/admin/groups?name=${encodeURIComponent(group.id)}`, {
        method: "DELETE",
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const matchingVideos = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return videos;
    return videos.filter((v) => (v.title || "").toLowerCase().includes(q));
  }, [videos, search]);

  return (
    <div className="stack-lg">
      <section className="card">
        <h3>Create a group</h3>
        <p className="muted small">
          A group is a viewer tag with rules attached. Create it here, then tag
          viewers with the same name from the Viewers tab. A new group starts
          unrestricted — it changes nothing until you turn on
          &quot;Restrict to selected videos&quot;.
        </p>
        <form onSubmit={create} className="row-actions">
          <input
            className="input"
            placeholder="Deck crew"
            value={newName}
            maxLength={30}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New group name"
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !newName.trim()}
          >
            Create group
          </button>
        </form>
        {note ? <div className="notice notice-ok">{note}</div> : null}
        {error ? <div className="notice notice-error">{error}</div> : null}
      </section>

      {untracked.length > 0 ? (
        <section className="card">
          <h3>Existing tags without a group</h3>
          <p className="muted small">
            These tags are already on viewers but have no group record, so they
            are plain labels. Create a group with the same name to attach an
            allowlist to one.
          </p>
          <div className="row-actions">
            {untracked.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setNewName(tag.id)}
              >
                {tag.id} ({tag.memberCount})
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="card">
        <h3>Groups ({groups ? groups.length : "…"})</h3>
        {groups === null ? (
          <p className="muted">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="muted">
            No groups yet. Every viewer sees the whole library.
          </p>
        ) : (
          <div className="row-list">
            {groups.map((group) => (
              <div key={group.id} className="row row-stack">
                <div className="row-main">
                  <strong className="row-title">{group.name}</strong>
                  <span className="muted small">
                    {group.memberCount} member
                    {group.memberCount === 1 ? "" : "s"} ·{" "}
                    {group.restricted
                      ? `restricted to ${group.videoIds.length} video${
                          group.videoIds.length === 1 ? "" : "s"
                        }${
                          group.collectionIds?.length
                            ? ` and ${group.collectionIds.length} collection${
                                group.collectionIds.length === 1 ? "" : "s"
                              }`
                            : ""
                        }`
                      : "unrestricted (label only)"}
                  </span>
                  {group.restricted &&
                  group.videoIds.length === 0 &&
                  (group.collectionIds?.length || 0) === 0 ? (
                    <span className="notice notice-error">
                      Restricted with an empty allowlist — members of this group
                      currently see nothing.
                    </span>
                  ) : null}
                </div>
                {editing === group.id ? null : (
                  <>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => startEdit(group)}
                    >
                      Edit access
                    </button>
                    {canEditMembers ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => openMembers(group)}
                      >
                        {membersFor === group.id ? "Hide members" : "Members"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="icon-btn icon-btn-danger"
                      aria-label={`Delete ${group.name}`}
                      onClick={() => remove(group)}
                    >
                      <TrashIcon size={14} />
                    </button>
                  </>
                )}

                {canEditMembers && membersFor === group.id && editing !== group.id ? (
                  <div className="stack" style={{ width: "100%" }}>
                    <span className="muted small">
                      Membership is a tag on each viewer — the same tag the
                      Viewers tab sets, edited here for a whole group at once.
                      Only people already on the viewer list can be added;
                      tagging does not approve anybody.
                    </span>
                    {(group.members || []).length ? (
                      <div className="chip-row">
                        {(group.members || []).map((email) => (
                          <span key={email} className="chip">
                            {email}
                            <button
                              type="button"
                              className="icon-btn"
                              aria-label={`Remove ${email} from ${group.name}`}
                              disabled={busy}
                              onClick={() => changeMembers(group, { remove: [email] })}
                            >
                              <XIcon size={11} />
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="muted small">Nobody is in this group yet.</span>
                    )}
                    <textarea
                      className="input textarea"
                      rows={3}
                      placeholder={"one@example.com\ntwo@example.com"}
                      value={memberDraft}
                      onChange={(e) => setMemberDraft(e.target.value)}
                      aria-label={`Add viewers to ${group.name}`}
                    />
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy || !memberDraft.trim()}
                        onClick={() =>
                          changeMembers(group, {
                            add: memberDraft.split(/[\s,;]+/).filter(Boolean),
                          })
                        }
                      >
                        Add to group
                      </button>
                    </div>
                    {memberNote ? <div className="notice notice-ok">{memberNote}</div> : null}
                  </div>
                ) : null}

                {editing === group.id ? (
                  <div className="stack" style={{ width: "100%" }}>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={draft.restricted}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, restricted: e.target.checked }))
                        }
                      />
                      <span>
                        Restrict to selected videos
                        <span className="muted small">
                          {" "}
                          — members see only what is ticked below. Leave off to
                          keep this group a plain label.
                        </span>
                      </span>
                    </label>

                    {draft.restricted ? (
                      <>
                        {/* Collections first: granting one is the cheaper
                            answer, because it FOLLOWS — a video uploaded into
                            it later is visible without anyone editing this
                            group. Ticking videos is the exception for a
                            one-off, not the default. */}
                        {collections.length ? (
                          <>
                            <span className="muted small">
                              Collections — everything in a ticked collection is
                              granted, including videos added to it later.
                            </span>
                            <div className="scroll-list">
                              {collections.map((c) => (
                                <label key={c.id} className="check-row">
                                  <input
                                    type="checkbox"
                                    checked={draft.collectionIds.includes(c.id)}
                                    onChange={() => toggleCollection(c.id)}
                                  />
                                  <span>{c.name}</span>
                                </label>
                              ))}
                            </div>
                            <span className="muted small">
                              {draft.collectionIds.length} collection
                              {draft.collectionIds.length === 1 ? "" : "s"} selected
                            </span>
                          </>
                        ) : null}

                        <span className="muted small">
                          Individual videos — added on top of any collections above.
                        </span>
                        <input
                          className="input input-sm"
                          placeholder="Search videos…"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          aria-label="Search videos"
                        />
                        <div className="scroll-list">
                          {matchingVideos.map((video) => (
                            <label key={video.id} className="check-row">
                              <input
                                type="checkbox"
                                checked={draft.videoIds.includes(video.id)}
                                onChange={() => toggleVideo(video.id)}
                              />
                              <span>{video.title || "Untitled"}</span>
                            </label>
                          ))}
                          {matchingVideos.length === 0 ? (
                            <p className="muted small">No videos match.</p>
                          ) : null}
                        </div>
                        <span className="muted small">
                          {draft.videoIds.length} selected
                        </span>
                      </>
                    ) : null}

                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy}
                        onClick={() => save(group.name)}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
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
  "viewer.tag": "Viewer tags updated",
  "role.create": "Role created",
  "role.update": "Role changed",
  "role.delete": "Role deleted",
  "role.assign": "Roles assigned",
  "role.migrate": "Legacy roles migrated",
  "access.request": "Access requested",
  "access.approve": "Access request approved",
  "access.deny": "Access request denied",
  "access.dismiss": "Access request dismissed",
  "group.save": "Group saved",
  "group.delete": "Group deleted",
  "share.create": "Share link created",
  "share.bulk_create": "Bulk share links created",
  "share.extend": "Share link(s) extended",
  "share.revoke": "Share link revoked",
  "share.unrevoke": "Share link restored",
  "share.delete": "Share link permanently deleted",
  "share.email": "Share link emailed",
  "share.list_add": "Private list: people added",
  "share.list_remove": "Private list: person removed",
  "video.rename": "Video renamed",
  "video.delete": "Video deleted",
  "video.upload": "Upload started",
  "video.upload.cancel": "Upload cancelled",
  "video.collection": "Video collection changed",
  "video.watermark": "Video watermark setting changed",
  "video.schedule": "Video schedule changed",
  "video.public_on": "Video made public",
  "video.public_off": "Public link turned off",
  "feed.rotate": "Podcast feed link regenerated",
  "video.chapters": "Video chapters changed",
  "video.notes": "Video notes changed",
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

// Each tab declares the capability it needs. Hiding a tab is a convenience
// so a manager isn't shown doors they can't open — the authorization itself
// lives in the /api/admin/* routes behind them.
const TABS = [
  ["videos", "Videos", CAP.VIDEOS_READ],
  ["viewers", "Viewers", CAP.VIEWERS_READ],
  ["roles", "Roles", CAP.ROLES_MANAGE],
  ["groups", "Groups", CAP.GROUPS_MANAGE],
  ["shares", "Shares", CAP.SHARES_READ],
  ["settings", "Settings", CAP.SETTINGS_MANAGE],
  ["activity", "Activity", CAP.AUDIT_READ],
  ["analytics", "Analytics", CAP.ANALYTICS_READ],
];

export default function Admin({ user, owner, capabilities, siteName }) {
  const can = useCallback(
    (capability) => (capabilities || []).includes(capability),
    [capabilities]
  );
  const visibleTabs = useMemo(
    () => TABS.filter(([, , capability]) => (capabilities || []).includes(capability)),
    [capabilities]
  );
  const [tab, setTab] = useState(() => visibleTabs[0]?.[0] || "videos");
  // The tabs below are pure React state, not routes — switching tabs fires
  // no navigation event, so the Query Monitor's per-view call log wouldn't
  // otherwise reset here. Without this, a tab that lazily fetches its own
  // data would show the previous tab's calls too, and a tab whose data
  // loaded once upfront would look frozen forever.
  useEffect(() => {
    resetMonitorCalls();
  }, [tab]);
  const [counts, setCounts] = useState({ viewers: null, shares: null });
  const [config, setConfig] = useState({
    videoCount: 30,
    siteName: "",
    envSiteName: "",
    maxSiteNameLength: 60,
    emailConfigured: false,
    emailFrom: null,
    pushConfigured: false,
    watermarkEnabled: false,
    podcastEnabled: false,
    podcastMediaReady: false,
    podcastMp4Height: 720,
    geoEnabled: false,
    adminGeoEnabled: false,
    geoWhitelist: [],
    adminGeoWhitelist: [],
    adminGeoBypassEmails: [],
  });

  useEffect(() => {
    if (can(CAP.SETTINGS_MANAGE)) {
      api("/api/admin/settings")
        .then((data) =>
          setConfig({
            videoCount: data.videoCount,
            siteName: data.siteName,
            envSiteName: data.envSiteName,
            maxSiteNameLength: data.maxSiteNameLength,
            emailConfigured: data.emailConfigured,
            emailFrom: data.emailFrom,
            pushConfigured: data.pushConfigured,
            watermarkEnabled: data.watermarkEnabled,
            podcastEnabled: data.podcastEnabled,
            podcastMediaReady: data.podcastMediaReady,
            podcastMp4Height: data.podcastMp4Height,
            geoEnabled: data.geoEnabled,
            adminGeoEnabled: data.adminGeoEnabled,
            geoWhitelist: data.geoWhitelist,
            adminGeoWhitelist: data.adminGeoWhitelist,
            adminGeoBypassEmails: data.adminGeoBypassEmails,
          })
        )
        .catch(() => {});
    }
    if (can(CAP.VIEWERS_READ)) {
      api("/api/admin/viewers")
        .then((data) => setCounts((c) => ({ ...c, viewers: data.viewers.length })))
        .catch(() => {});
    }
    if (can(CAP.SHARES_READ)) {
      api("/api/admin/shares")
        .then((data) => setCounts((c) => ({ ...c, shares: data.shares.length })))
        .catch(() => {});
    }
  }, [can]);

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
    <AppShell user={user} admin canNotify siteName={siteName}>
      <Head>
        <title>{pageTitle("Admin", siteName)}</title>
      </Head>
      <h1 className="page-title">
        Admin
        {!owner ? (
          <span
            className="tag-chip"
            style={{ marginLeft: "0.6rem" }}
            title="Your access comes from the roles you hold, not from ADMIN_EMAILS"
          >
            {(capabilities || []).length} of {ALL_CAPABILITIES.length} capabilities
          </span>
        ) : null}
      </h1>
      <div className="tabs" role="tablist">
        {visibleTabs.map(([key, label]) => (
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
          // Making a video reachable without a login is a site-policy
          // decision, not library management, so it is admin-only. The route
          // behind it enforces CAP.SETTINGS_MANAGE independently — hiding the
          // control is a convenience, never the boundary.
          canPublish={can(CAP.SETTINGS_MANAGE)}
          canGrantGroups={can(CAP.GROUPS_MANAGE)}
        />
      ) : null}
      {tab === "viewers" ? (
        <ViewersTab onCount={setViewerCount} me={user.email} />
      ) : null}
      {tab === "roles" ? <RolesTab /> : null}
      {tab === "groups" ? <GroupsTab /> : null}
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
