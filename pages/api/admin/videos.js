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
import { getOrder, pruneFromOrder } from "../../../lib/store";
import { logAction } from "../../../lib/audit";

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === "GET") {
    try {
      const [all, order] = await Promise.all([
        listAllVideos(),
        getOrder().catch(() => []),
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
      }));
      return res.json({ videos, thumbnails: thumbnailsEnabled() });
    } catch (err) {
      console.error("Could not load videos from bunny.net:", err);
      return res.status(502).json({ error: "Could not load videos from bunny.net" });
    }
  }

  if (req.method === "POST") {
    const { action, id } = req.body || {};
    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "Video id is required" });
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
