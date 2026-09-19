// Admin video library: ordered list with encoding status, rename,
// collection assignment, chapters, sermon notes, and delete (which also
// prunes the saved order).
import { requireCapability } from "../../../lib/guard";
import { CAP } from "../../../lib/roles";
import {
  deleteVideo,
  listAllVideos,
  thumbnailsEnabled,
  thumbnailUrl,
  updateVideo,
  videoState,
} from "../../../lib/bunny";
import { applyOrder } from "../../../lib/order";
import {
  getOrder,
  getVideoWatermarkOverrides,
  pruneFromOrder,
  setVideoWatermarkOverride,
} from "../../../lib/store";
import { pruneVideoFromGroups } from "../../../lib/groups";
import { getPublicMap, prunePublicVideo } from "../../../lib/publicVideos";
import { beyondDuration, formatTimestamp, parseChapters } from "../../../lib/chapters";
import { MAX_NOTES_LENGTH } from "../../../lib/notes";
import { oneNumber, oneString, oneTrimmed } from "../../../lib/params";
import {
  getChaptersMap,
  getNotesMap,
  pruneVideoMeta,
  setChapters,
  setNotes,
} from "../../../lib/videoMeta";
import {
  clearSchedule,
  getScheduleMap,
  scheduleState,
  setSchedule,
  validateWindow,
} from "../../../lib/schedule";
import { logAction } from "../../../lib/audit";
import { maybeAnnounceReadyVideos } from "../../../lib/push";
import { clampWatermarkMode } from "../../../lib/watermark";
import { withMonitorApi } from "../../../lib/monitor";

const MAX_BULK_IDS = 100;

async function handler(req, res) {
  const access = await requireCapability(
    req,
    res,
    req.method === "GET" ? CAP.VIDEOS_READ : CAP.VIDEOS_MANAGE
  );
  if (!access) return;
  const admin = access.email;

  if (req.method === "GET") {
    try {
      const [all, order, watermarkOverrides, schedules, chapters, notes, publicMap] =
        await Promise.all([
          listAllVideos(),
          getOrder().catch(() => []),
          getVideoWatermarkOverrides().catch(() => ({})),
          getScheduleMap().catch(() => ({})),
          // Decoration, not access control: an unreadable hash costs the
          // admin the editor's current contents, never the video list.
          getChaptersMap().catch(() => ({})),
          getNotesMap().catch(() => ({})),
          // Read-only here so the Videos tab can badge which videos are
          // public. CHANGING the flag is a CAP.SETTINGS_MANAGE action on its own
          // route (pages/api/admin/public-videos.js) — a manager can see
          // that a video is public but cannot make one public.
          getPublicMap().catch(() => ({})),
        ]);
      const now = Date.now();
      const videos = applyOrder(all, order).map((video) => ({
        id: video.guid,
        title: video.title || "Untitled",
        status: videoState(video),
        encodeProgress: video.encodeProgress ?? 0,
        thumbnail: thumbnailUrl(video),
        collectionId: video.collectionId || "",
        length: video.length || 0,
        dateUploaded: video.dateUploaded || null,
        views: video.views ?? 0,
        watermark: watermarkOverrides[video.guid] || "default",
        // Staff always see every video; the schedule is surfaced as state so
        // the admin list can badge what viewers can't currently see.
        schedule: schedules[video.guid] || null,
        scheduleState: scheduleState(schedules[video.guid], now),
        chapters: chapters[video.guid] || [],
        notes: notes[video.guid] || "",
        public: Boolean(publicMap[video.guid]),
      }));
      // Best-effort: announce any newly-ready video to subscribers. Never let
      // a push failure break the admin video list.
      try {
        await maybeAnnounceReadyVideos(videos);
      } catch (err) {
        console.error("New-video announce failed:", err);
      }
      return res.json({ videos, thumbnails: thumbnailsEnabled() });
    } catch (err) {
      console.error("Could not load videos from bunny.net:", err);
      return res.status(502).json({ error: "Could not load videos from bunny.net" });
    }
  }

  if (req.method === "POST") {
    const { action } = req.body || {};

    if (action === "bulk-delete") {
      const ids = Array.isArray(req.body?.ids)
        ? [...new Set(req.body.ids.filter((v) => typeof v === "string" && v))]
        : [];
      if (!ids.length) {
        return res.status(400).json({ error: "Select at least one video to delete" });
      }
      if (ids.length > MAX_BULK_IDS) {
        return res.status(400).json({ error: `Delete at most ${MAX_BULK_IDS} videos at once` });
      }
      const results = {};
      await Promise.all(
        ids.map(async (videoId) => {
          try {
            await deleteVideo(videoId);
            await pruneFromOrder(videoId).catch(() => {});
            await pruneVideoFromGroups(videoId).catch(() => {});
            await clearSchedule(videoId).catch(() => {});
            await pruneVideoMeta(videoId).catch(() => {});
            await prunePublicVideo(videoId).catch(() => {});
            results[videoId] = { ok: true };
          } catch (err) {
            console.error("Bulk delete failed on bunny.net:", err);
            results[videoId] = { ok: false, error: "Delete failed on bunny.net" };
          }
        })
      );
      const succeeded = Object.values(results).filter((r) => r.ok).length;
      if (succeeded > 0) {
        await logAction(admin, "video.bulk_delete", `Deleted ${succeeded}/${ids.length} video(s)`);
      }
      return res.json({ results });
    }

    if (action === "bulk-set-collection") {
      const ids = Array.isArray(req.body?.ids)
        ? [...new Set(req.body.ids.filter((v) => typeof v === "string" && v))]
        : [];
      const collectionId = oneTrimmed(req.body?.collectionId) || "";
      if (!ids.length) {
        return res.status(400).json({ error: "Select at least one video" });
      }
      if (ids.length > MAX_BULK_IDS) {
        return res.status(400).json({ error: `Update at most ${MAX_BULK_IDS} videos at once` });
      }
      const results = {};
      await Promise.all(
        ids.map(async (videoId) => {
          try {
            await updateVideo(videoId, { collectionId });
            results[videoId] = { ok: true };
          } catch (err) {
            console.error("Bulk collection change failed on bunny.net:", err);
            results[videoId] = { ok: false, error: "Collection change failed on bunny.net" };
          }
        })
      );
      const succeeded = Object.values(results).filter((r) => r.ok).length;
      if (succeeded > 0) {
        await logAction(
          admin,
          "video.bulk_collection",
          `${collectionId ? "Assigned" : "Removed"} collection for ${succeeded}/${ids.length} video(s)`
        );
      }
      return res.json({ results });
    }

    const { id } = req.body || {};
    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "Video id is required" });
    }

    if (action === "set-schedule") {
      const publishAt = req.body?.publishAt || null;
      const expiresAt = req.body?.expiresAt || null;
      const problem = validateWindow({ publishAt, expiresAt });
      if (problem) return res.status(400).json({ error: problem });
      let saved;
      try {
        saved = await setSchedule(id, { publishAt, expiresAt });
      } catch (err) {
        console.error("Could not save the video schedule:", err);
        return res.status(502).json({ error: "Could not save the video schedule" });
      }
      await logAction(
        admin,
        "video.schedule",
        saved
          ? `${id} → ${saved.publishAt || "now"} to ${saved.expiresAt || "forever"}`
          : `${id} → always available`
      );
      return res.json({ ok: true, schedule: saved });
    }

    if (action === "set-chapters") {
      // Parsing is pure (lib/chapters.js) and happens here rather than in the
      // browser so what gets stored is what the server read, not what a
      // client claims it read.
      // Strict string: an array here would otherwise be stringified into a
      // chapter list nobody typed (see lib/params.js).
      const { chapters, ignored } = parseChapters(oneString(req.body?.text) || "");
      let saved;
      try {
        saved = await setChapters(id, chapters);
      } catch (err) {
        console.error("Could not save the video chapters:", err);
        return res.status(502).json({ error: "Could not save the chapters" });
      }
      // `durationSeconds`, NOT `length`: `req.body.length` reads the built-in
      // size property when the body is an array or a string rather than an
      // object, which is the type confusion CodeQL flagged here (Critical).
      // The name change removes the collision; oneNumber removes the coercion.
      const duration = oneNumber(req.body?.durationSeconds, 0);
      const late = beyondDuration(saved, duration).map((c) => formatTimestamp(c.t));
      await logAction(admin, "video.chapters", `${id} → ${saved.length} chapter(s)`);
      // Ignored lines are reported, never silently dropped — the admin needs
      // to know a line they typed did not become a chapter.
      return res.json({ ok: true, chapters: saved, ignored, beyondDuration: late });
    }

    if (action === "set-notes") {
      const text = oneString(req.body?.text) || "";
      if (text.length > MAX_NOTES_LENGTH * 2) {
        return res
          .status(400)
          .json({ error: `Notes must be at most ${MAX_NOTES_LENGTH} characters` });
      }
      let saved;
      try {
        saved = await setNotes(id, text);
      } catch (err) {
        console.error("Could not save the video notes:", err);
        return res.status(502).json({ error: "Could not save the notes" });
      }
      await logAction(admin, "video.notes", saved ? `${id} → ${saved.length} chars` : `${id} → cleared`);
      return res.json({ ok: true, notes: saved || "" });
    }

    if (action === "set-watermark") {
      const mode = clampWatermarkMode(req.body?.watermark);
      try {
        await setVideoWatermarkOverride(id, mode);
      } catch (err) {
        console.error("Could not save the video's watermark setting:", err);
        return res.status(502).json({ error: "Could not save the video's watermark setting" });
      }
      await logAction(admin, "video.watermark", `${id} → ${mode}`);
      return res.json({ ok: true });
    }

    if (action === "rename") {
      const title = oneTrimmed(req.body?.title) || "";
      if (!title || title.length > 200) {
        return res.status(400).json({ error: "Title must be 1-200 characters" });
      }
      try {
        await updateVideo(id, { title });
      } catch (err) {
        console.error("Rename failed on bunny.net:", err);
        return res.status(502).json({ error: "Rename failed on bunny.net" });
      }
      await logAction(admin, "video.rename", title);
      return res.json({ ok: true });
    }

    if (action === "set-collection") {
      const collectionId = oneTrimmed(req.body?.collectionId) || "";
      try {
        await updateVideo(id, { collectionId });
      } catch (err) {
        console.error("Collection change failed on bunny.net:", err);
        return res.status(502).json({ error: "Collection change failed on bunny.net" });
      }
      await logAction(
        admin,
        "video.collection",
        collectionId ? "assigned to collection" : "removed from collection"
      );
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  }

  if (req.method === "DELETE") {
    const id = oneTrimmed(req.query.id);
    if (!id) return res.status(400).json({ error: "Video id is required" });
    try {
      await deleteVideo(id);
    } catch (err) {
      console.error("Delete failed on bunny.net:", err);
      return res.status(502).json({ error: "Delete failed on bunny.net" });
    }
    await pruneFromOrder(id).catch(() => {});
    // Best-effort, like the order prune: a deleted video must not linger on
    // a group's allowlist where a recycled id could inherit its grant.
    await pruneVideoFromGroups(id).catch(() => {});
    await clearSchedule(id).catch(() => {});
    await pruneVideoMeta(id).catch(() => {});
    // A stale public row on a recycled bunny.net id would inherit a public
    // grant — the worst direction for this flag to leak.
    await prunePublicVideo(id).catch(() => {});
    await logAction(admin, "video.delete", id);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
