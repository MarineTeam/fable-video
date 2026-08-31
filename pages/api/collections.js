// Collection list for the homepage filter chips (approved viewers).
// A group-restricted viewer only gets the collections that actually hold at
// least one video they may see — otherwise the chip row would enumerate the
// names of collections whose contents are hidden from them.
import { requireAccess } from "../../lib/guard";
import { listAllVideos, listCollections } from "../../lib/bunny";
import { withMonitorApi } from "../../lib/monitor";

async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const access = await requireAccess(req, res);
  if (!access) return;

  try {
    const collections = await listCollections();
    let visible = collections;
    if (Array.isArray(access.videoScope)) {
      const allowed = new Set(access.videoScope);
      const videos = await listAllVideos();
      const withVisibleVideos = new Set(
        videos.filter((v) => allowed.has(v.guid)).map((v) => v.collectionId)
      );
      visible = collections.filter((c) => withVisibleVideos.has(c.guid));
    }
    return res.json({
      collections: visible.map((c) => ({
        id: c.guid,
        name: c.name || "Untitled",
        videoCount: c.videoCount || 0,
      })),
    });
  } catch (err) {
    console.error("Could not load collections:", err);
    return res.status(502).json({ error: "Could not load collections" });
  }
}

export default withMonitorApi(handler);
