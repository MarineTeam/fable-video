// Admin video library: ordered list with encoding status, rename,
// collection assignment, and delete (which also prunes the saved order).
import { requireAdmin } from "../../../lib/guard";
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
import { logAction } from "../../../lib/audit";
import { maybeAnnounceReadyVideos } from "../../../lib/push";
import { clampWatermarkMode } from "../../../lib/watermark";

const MAX_BULK_IDS = 100;

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === "GET") {
    try {
      const [all, order, watermarkOverrides] = await Promise.all([
        listAllVideos(),
        getOrder().catch(() => []),
        getVideoWatermarkOverrides().catch(() => ({})),
      ]);
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
      const collectionId = String(req.body?.collectionId || "");
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
      const title = String(req.body?.title || "").trim();
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
      const collectionId = String(req.body?.collectionId || "");
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
    const id = String(req.query.id || "");
    if (!id) return res.status(400).json({ error: "Video id is required" });
    try {
      await deleteVideo(id);
    } catch (err) {
      console.error("Delete failed on bunny.net:", err);
      return res.status(502).json({ error: "Delete failed on bunny.net" });
    }
    await pruneFromOrder(id).catch(() => {});
    await logAction(admin, "video.delete", id);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
