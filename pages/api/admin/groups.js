// Group management, gated on CAP.GROUPS_MANAGE — a group's allowlist
// decides who can watch what, so it belongs with people management rather
// than with the video library a manager runs.
//
// This route owns the group RECORD — its display name, whether it restricts,
// and which videos it allows — and, via PATCH, its MEMBERSHIP.
//
// Membership is stored as a tag on each viewer, so editing it is editing
// viewer records. That is why PATCH, and the member list in GET, additionally
// require CAP.VIEWERS_READ: naming a group's members hands out addresses, and
// the per-address result of a change answers "is this person an approved
// viewer?", which is the same question. A groups-only manager keeps exactly
// what they had before — the record and a member COUNT.
//
// Writing membership needs no further capability beyond groups.manage,
// deliberately: a groups.manage holder can already change what every member
// of a group sees by editing the record (widening the allowlist, clearing
// `restricted`, or deleting the group), so moving a viewer between groups
// grants no power they did not have. What it adds is visibility of people,
// which is what the viewers.read requirement covers.
import { requireCapability } from "../../../lib/guard";
import { hasCapability } from "../../../lib/capabilities";
import { oneTrimmed } from "../../../lib/params";
import { CAP } from "../../../lib/roles";
import {
  MAX_COLLECTIONS_PER_GROUP,
  MAX_GROUP_NAME_LENGTH,
  MAX_MEMBERSHIP_CHANGES,
  MAX_TAGS_PER_VIEWER,
  MAX_VIDEOS_PER_GROUP,
  deleteGroup,
  getGroup,
  groupId,
  isValidGroupName,
  listGroups,
  membersOfGroup,
  planMembershipChange,
  saveGroup,
} from "../../../lib/groups";
import { listViewers, setViewerTags } from "../../../lib/store";
import { logAction } from "../../../lib/audit";
import { pruneGroupFromSchedules } from "../../../lib/schedule";
import { withMonitorApi } from "../../../lib/monitor";

async function handler(req, res) {
  const access = await requireCapability(req, res, CAP.GROUPS_MANAGE);
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
      // Addresses only for a caller who may read the viewer list; everyone
      // else gets the count, exactly as before this feature existed.
      const maySeePeople = hasCapability(access, CAP.VIEWERS_READ);
      const known = new Set(groups.map((g) => g.id));
      const untracked = Object.keys(memberCounts)
        .filter((id) => !known.has(id))
        .sort();
      return res.json({
        groups: groups.map((g) => ({
          ...g,
          memberCount: memberCounts[g.id] || 0,
          ...(maySeePeople ? { members: membersOfGroup(viewers, g.id) } : {}),
        })),
        canEditMembers: maySeePeople,
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

  // Bulk membership. See the header for why this needs viewers.read on top of
  // the groups.manage the guard already enforced.
  if (req.method === "PATCH") {
    if (!hasCapability(access, CAP.VIEWERS_READ)) {
      return res.status(403).json({ error: "You don't have permission to do that" });
    }

    const name = oneTrimmed(req.body?.name) || "";
    if (!groupId(name)) return res.status(400).json({ error: "Group name is required" });

    const add = Array.isArray(req.body?.add) ? req.body.add : [];
    const remove = Array.isArray(req.body?.remove) ? req.body.remove : [];
    if (add.length + remove.length === 0) {
      return res.status(400).json({ error: "Name at least one viewer to add or remove" });
    }
    if (add.length + remove.length > MAX_MEMBERSHIP_CHANGES) {
      return res
        .status(400)
        .json({ error: `At most ${MAX_MEMBERSHIP_CHANGES} changes at once` });
    }

    let viewers;
    let group;
    try {
      [viewers, group] = await Promise.all([listViewers(), getGroup(name)]);
    } catch (err) {
      console.error("Could not load viewers for a membership change:", err);
      return res.status(502).json({ error: "Could not change the membership" });
    }

    // The group's stored display name if it has a record, so membership uses
    // the canonical spelling rather than however the caller typed it. A tag
    // with no group record is a plain label and can still be applied — that is
    // how an admin builds a group before deciding it should restrict.
    const canonical = group?.name || name;
    const plan = planMembershipChange(viewers, canonical, { add, remove, maxTags: MAX_TAGS_PER_VIEWER });

    const failed = [];
    for (const write of plan.writes) {
      try {
        const ok = await setViewerTags(write.email, write.tags);
        if (!ok) failed.push(write.email);
      } catch (err) {
        console.error("Could not save viewer tags:", err);
        failed.push(write.email);
      }
    }

    // A failed write must not be reported as a change. The viewer stopped
    // being on the list between the read and the write, or Redis refused —
    // either way the tag is not there, and saying it is would be a lie an
    // admin acts on.
    const failedSet = new Set(failed);
    const added = plan.added.filter((email) => !failedSet.has(email));
    const removed = plan.removed.filter((email) => !failedSet.has(email));

    if (added.length || removed.length) {
      await logAction(
        admin,
        "group.members",
        `${groupId(canonical)} +${added.length} -${removed.length}`
      );
    }
    return res.json({
      ok: true,
      added,
      removed,
      // Every address the caller named that did nothing, and why. Reporting
      // "saved" over a list where three of twelve were typos is how an admin
      // discovers the mistake a month later.
      noop: plan.noop,
      unknown: plan.unknown,
      overflow: plan.overflow,
      failed,
      members: membersOfGroup(
        viewers.map((viewer) => {
          const write = plan.writes.find((w) => w.email === viewer.email);
          return write && !failedSet.has(viewer.email) ? { ...viewer, tags: write.tags } : viewer;
        }),
        canonical
      ),
    });
  }

  if (req.method === "PUT") {
    const name = oneTrimmed(req.body?.name) || "";
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

    const rawCollectionIds = Array.isArray(req.body?.collectionIds) ? req.body.collectionIds : [];
    if (rawCollectionIds.length > MAX_COLLECTIONS_PER_GROUP) {
      return res
        .status(400)
        .json({ error: `At most ${MAX_COLLECTIONS_PER_GROUP} collections per group` });
    }
    if (rawCollectionIds.some((id) => typeof id !== "string" || id.length > 100)) {
      return res.status(400).json({ error: "Invalid collection id in the allowlist" });
    }

    const patch = { name: name.trim(), videoIds: rawVideoIds, collectionIds: rawCollectionIds };
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
        ? `${saved.name} (${saved.videoIds.length} videos, ${saved.collectionIds.length} collections)`
        : `${saved.name} (unrestricted)`
    );
    return res.json({ ok: true, group: saved });
  }

  if (req.method === "DELETE") {
    const name = oneTrimmed(req.query.name) || "";
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
    // Per-group publish windows are keyed on the group id, which is derived
    // from the NAME — a later group called the same would otherwise inherit
    // every early-access window this one had. Best-effort: the group is gone
    // either way, and a leftover window only matters if the name comes back.
    await pruneGroupFromSchedules(groupId(name)).catch((err) =>
      console.error("Could not clear the group's publish windows:", err)
    );
    // Deleting the record drops the restriction; the tag itself stays on
    // viewers and reverts to being a plain label.
    await logAction(admin, "group.delete", groupId(name));
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, PUT, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
