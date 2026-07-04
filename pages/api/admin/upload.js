// Browser -> bunny.net uploads: creates the video record and returns signed
// TUS credentials so the file goes straight from the admin's browser to
// bunny.net. DELETE cleans up a cancelled upload's half-created video.
import { requireAdmin } from "../../../lib/guard";
import { allowRequest } from "../../../lib/ratelimit";
import { createVideo, deleteVideo, signTusUpload } from "../../../lib/bunny";
import { pruneFromOrder } from "../../../lib/store";
import { logAction } from "../../../lib/audit";

export default async function handler(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === "POST") {
    if (!(await allowRequest("upload", admin, 30, "1 h"))) {
      return res
        .status(429)
        .json({ error: "Too many uploads started — try again shortly" });
    }
    const title = String(req.body?.title || "").trim().slice(0, 200);
    if (!title) return res.status(400).json({ error: "A title is required" });
    const collectionId = String(req.body?.collectionId || "") || undefined;

    let video;
    try {
      video = await createVideo(title, collectionId);
    } catch {
      return res.status(502).json({ error: "Could not create the video on bunny.net" });
    }
    await logAction(admin, "video.upload", title);
    return res.status(201).json({
      video: { id: video.guid, title },
      tus: signTusUpload(video.guid),
    });
  }

  if (req.method === "DELETE") {
    const id = String(req.query.id || "");
    if (!id) return res.status(400).json({ error: "Video id is required" });
    try {
      await deleteVideo(id);
    } catch {
      return res.status(502).json({ error: "Could not clean up the video" });
    }
    await pruneFromOrder(id).catch(() => {});
    await logAction(admin, "video.upload.cancel", id);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
