// Group management. Full admins only (CAP.PEOPLE) — a group's allowlist
// decides who can watch what, so it belongs with people management rather
// than with the video library a manager runs.
//
// Membership itself is not edited here: a viewer belongs to a group by
// carrying its tag, which is still done from the Viewers tab
// (/api/admin/viewers PATCH). This route owns the group RECORD — its display
// name, whether it restricts, and which videos it allows.
import { requireCapability } from "../../../lib/guard";
import { CAP } from "../../../lib/roles";
import {
  MAX_GROUP_NAME_LENGTH,
  MAX_VIDEOS_PER_GROUP,
  deleteGroup,
  groupId,
  isValidGroupName,
  listGroups,
  saveGroup,
} from "../../../lib/groups";
import { listViewers } from "../../../lib/store";
import { logAction } from "../../../lib/audit";
import { withMonitorApi } from "../../../lib/monitor";

async function handler(req, res) {
  const access = await requireCapability(req, res, CAP.PEOPLE);
  if (!access) return;
  const admin = access.email;

  if (req.method === "GET") {
    try {
      // Every tag in use, so the UI can offer to define a group for a tag
      // that exists on viewers but has no record yet.
      const [groups, viewers] = await Promise.all([listGroups(), listViewers()]);
      const memberCounts = {};
      for (const viewer of viewers) {
        for (const tag of viewer.tags || []) {
          const id = groupId(tag);
          memberCounts[id] = (memberCounts[id] || 0) + 1;
        }
      }
      const known = new Set(groups.map((g) => g.id));
      const untracked = Object.keys(memberCounts)
        .filter((id) => !known.has(id))
        .sort();
      return res.json({
        groups: groups.map((g) => ({ ...g, memberCount: memberCounts[g.id] || 0 })),
        untrackedTags: untracked.map((id) => ({
          id,
          memberCount: memberCounts[id],
        })),
      });
    } catch (err) {
      console.error("Could not load groups:", err);
      return res.status(502).json({ error: "Could not load groups" });
    }
  }

  if (req.method === "PUT") {
    const name = String(req.body?.name || "");
    if (!isValidGroupName(name)) {
      return res.status(400).json({
        error: `Group names must be 1-${MAX_GROUP_NAME_LENGTH} characters`,
      });
    }
    const rawVideoIds = Array.isArray(req.body?.videoIds) ? req.body.videoIds : [];
    if (rawVideoIds.length > MAX_VIDEOS_PER_GROUP) {
      return res
        .status(400)
        .json({ error: `At most ${MAX_VIDEOS_PER_GROUP} videos per group` });
    }
    if (rawVideoIds.some((id) => typeof id !== "string" || id.length > 100)) {
      return res.status(400).json({ error: "Invalid video id in the allowlist" });
    }

    const patch = { name: name.trim(), videoIds: rawVideoIds };
    if (req.body?.restricted !== undefined) {
      patch.restricted = req.body.restricted === true;
    }

    let saved;
    try {
      saved = await saveGroup(name, patch, admin);
    } catch (err) {
      console.error("Could not save the group:", err);
      return res.status(502).json({ error: "Could not save the group" });
    }
    await logAction(
      admin,
      "group.save",
      saved.restricted
        ? `${saved.name} (${saved.videoIds.length} videos)`
        : `${saved.name} (unrestricted)`
    );
    return res.json({ ok: true, group: saved });
  }

  if (req.method === "DELETE") {
    const name = String(req.query.name || "");
    if (!groupId(name)) {
      return res.status(400).json({ error: "Group name is required" });
    }
    let removed;
    try {
      removed = await deleteGroup(name);
    } catch (err) {
      console.error("Could not delete the group:", err);
      return res.status(502).json({ error: "Could not delete the group" });
    }
    if (!removed) return res.status(404).json({ error: "Group not found" });
    // Deleting the record drops the restriction; the tag itself stays on
    // viewers and reverts to being a plain label.
    await logAction(admin, "group.delete", groupId(name));
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
