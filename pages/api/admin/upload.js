// Browser -> bunny.net uploads: creates the video record and returns signed
// TUS credentials so the file goes straight from the admin's browser to
// bunny.net. DELETE cleans up a cancelled upload's half-created video.
import { requireCapability } from "../../../lib/guard";
import { CAP } from "../../../lib/roles";
import { allowRequest } from "../../../lib/ratelimit";
import { createVideo, deleteVideo, signTusUpload } from "../../../lib/bunny";
import { pruneFromOrder } from "../../../lib/store";
import { logAction } from "../../../lib/audit";
import { hasCapability } from "../../../lib/capabilities";
import {
  getGroupMap,
  grantVideoToGroups,
  MAX_VIDEOS_PER_GROUP,
  pruneVideoFromGroups,
} from "../../../lib/groups";
import { planUploadGrants } from "../../../lib/uploadGrants";
import { SCOPED_REFUSAL, scopedDeleteProblem } from "../../../lib/staffScope";
import { effectiveScopeGroups, isScoped } from "../../../lib/staffScopeRules";
import { oneTrimmed } from "../../../lib/params";
import { withMonitorApi } from "../../../lib/monitor";

async function handler(req, res) {
  const access = await requireCapability(req, res, CAP.VIDEOS_UPLOAD);
  if (!access) return;
  const admin = access.email;

  if (req.method === "POST") {
    if (!(await allowRequest("upload", admin, 30, "1 h"))) {
      return res
        .status(429)
        .json({ error: "Too many uploads started — try again shortly" });
    }
    const title = (oneTrimmed(req.body?.title) || "").slice(0, 200);
    if (!title) return res.status(400).json({ error: "A title is required" });
    const collectionId = oneTrimmed(req.body?.collectionId) || undefined;
    const scoped = isScoped(access);
    // A collection can be granted to groups outside the caller's scope, so
    // choosing one would decide who else sees the video.
    if (scoped && collectionId) return res.status(403).json({ error: SCOPED_REFUSAL });

    // Groups this upload should be visible to. Everything that can refuse the
    // request is decided HERE, before the bunny.net video exists — a refusal
    // after createVideo would leave an orphan in the library.
    let groupIds = [];
    const requestedGroups = req.body?.groupIds;
    if (scoped) {
      // A group-scoped uploader's video goes to their own groups — the ones
      // they chose, or all of them — and never to anyone else's. Granting
      // their own groups needs no groups.manage: it is the only way the video
      // lands inside their scope at all.
      let groupMap;
      try {
        groupMap = await getGroupMap();
      } catch (err) {
        console.error("Could not read groups for an upload:", err);
        return res.status(502).json({ error: "Could not read groups — try again" });
      }
      const mine = effectiveScopeGroups(access.staffScope, groupMap);
      const wanted = requestedGroups === undefined || requestedGroups === null ? mine : requestedGroups;
      if (Array.isArray(wanted) && wanted.some((id) => typeof id !== "string" || !mine.includes(id))) {
        return res.status(403).json({ error: "You can only grant an upload to your own groups" });
      }
      const plan = planUploadGrants(wanted, groupMap, { maxVideosPerGroup: MAX_VIDEOS_PER_GROUP });
      if (!plan.ok) return res.status(plan.status).json({ error: plan.error });
      if (!plan.groupIds.length) {
        return res.status(400).json({ error: "Choose at least one of your groups for this video" });
      }
      groupIds = plan.groupIds;
    } else if (requestedGroups !== undefined && requestedGroups !== null) {
      // Granting a group is a groups.manage act, whatever form it arrives
      // through. Under custom roles "may upload" and "may manage groups" are
      // separate capabilities, so an uploader without the second must not
      // gain it by ticking a box.
      if (!hasCapability(access, CAP.GROUPS_MANAGE)) {
        return res.status(403).json({ error: "You don't have permission to do that" });
      }
      let groupMap;
      try {
        groupMap = await getGroupMap();
      } catch (err) {
        console.error("Could not read groups for an upload:", err);
        return res.status(502).json({ error: "Could not read groups — try again" });
      }
      const plan = planUploadGrants(requestedGroups, groupMap, {
        maxVideosPerGroup: MAX_VIDEOS_PER_GROUP,
      });
      if (!plan.ok) return res.status(plan.status).json({ error: plan.error });
      groupIds = plan.groupIds;
    }

    let video;
    try {
      video = await createVideo(title, collectionId);
    } catch (err) {
      console.error("Could not create the video on bunny.net:", err);
      return res.status(502).json({ error: "Could not create the video on bunny.net" });
    }
    await logAction(admin, "video.upload", title);

    // After the video exists, a grant failing must not fail the upload — the
    // browser is about to send the file. Reported per group instead.
    const groups = groupIds.length
      ? await grantVideoToGroups(video.guid, groupIds)
      : { granted: [], failed: [] };
    if (groups.granted.length) {
      await logAction(
        admin,
        "group.grant",
        `${title} → ${groups.granted.join(", ")}`
      );
    }

    return res.status(201).json({
      video: { id: video.guid, title },
      tus: signTusUpload(video.guid),
      groups,
    });
  }

  if (req.method === "DELETE") {
    const id = oneTrimmed(req.query.id);
    if (!id) return res.status(400).json({ error: "Video id is required" });
    // Cancelling an upload deletes a video by id, so it is held to the same
    // rule as the Videos tab's delete.
    const refused = await scopedDeleteProblem(access, id);
    if (refused) return res.status(refused.status).json({ error: refused.error });
    try {
      await deleteVideo(id);
    } catch (err) {
      console.error("Could not clean up the video:", err);
      return res.status(502).json({ error: "Could not clean up the video" });
    }
    await pruneFromOrder(id).catch(() => {});
    // The upload may already have granted this video to groups.
    await pruneVideoFromGroups(id).catch(() => {});
    await logAction(admin, "video.upload.cancel", id);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
