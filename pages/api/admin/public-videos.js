// Turns a single video's public (no-login) link on or off.
//
// Its OWN route rather than another action on pages/api/admin/videos.js, for
// two reasons. First, that route authorizes CAP.VIDEOS, which a manager
// holds; publishing a video to the open internet is a site-policy decision,
// not library management, so it is gated on CAP.SETTINGS — admins only. A
// capability check that has to be *re-tightened* halfway down a long handler
// is the kind that eventually gets missed. Second, the whole point of the
// public feature is that it is auditable in isolation: one flag, two files
// (this and pages/watch/public/[id].js).
import { requireCapability } from "../../../lib/guard";
import { CAP } from "../../../lib/roles";
import {
  getPublicMap,
  publicVideoUrl,
  setPublicVideo,
  unsetPublicVideo,
} from "../../../lib/publicVideos";
import { isExplicitlyTrue, oneTrimmed } from "../../../lib/params";
import { logAction } from "../../../lib/audit";
import { withMonitorApi } from "../../../lib/monitor";

async function handler(req, res) {
  // Guard first, before the method check — see change-control rule 1.
  const access = await requireCapability(req, res, CAP.SETTINGS);
  if (!access) return;
  const admin = access.email;

  if (req.method === "GET") {
    try {
      const map = await getPublicMap();
      const videos = Object.entries(map).map(([id, record]) => ({
        id,
        ...record,
        url: publicVideoUrl(id),
      }));
      return res.json({ videos, baseUrlConfigured: Boolean(publicVideoUrl("x")) });
    } catch (err) {
      console.error("Could not load the public video list:", err);
      return res.status(502).json({ error: "Could not load the public video list" });
    }
  }

  if (req.method === "POST") {
    const id = oneTrimmed(req.body?.id);
    if (!id) return res.status(400).json({ error: "Video id is required" });
    // Explicit boolean — never "truthy means publish". Turning this on is the
    // one action in the app that widens access to everyone, so it must be
    // asked for in so many words.
    const isPublic = isExplicitlyTrue(req.body?.public);

    try {
      if (isPublic) await setPublicVideo(id, admin);
      else await unsetPublicVideo(id);
    } catch (err) {
      console.error("Could not change a video's public setting:", err);
      return res.status(502).json({ error: "Could not change the public setting" });
    }

    await logAction(admin, isPublic ? "video.public_on" : "video.public_off", id);
    return res.json({
      ok: true,
      public: isPublic,
      url: isPublic ? publicVideoUrl(id) : null,
    });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
