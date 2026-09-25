// Approved viewer management: list (with last-seen and assigned roles), add
// (single or bulk paste — validated and deduped), tag (group membership),
// and remove. Roles are DEFINED and ASSIGNED through /api/admin/roles; this
// route only reports which ones a person holds, so the Viewers tab can show
// one list of people rather than two that can disagree.
import { requireCapability } from "../../../lib/guard";
import { isEnvAdmin, normalizeEmail, parseEmailList } from "../../../lib/auth";
import {
  addViewers,
  listViewers,
  removeViewer,
  setViewerTags,
} from "../../../lib/store";
import {
  CAP,
  clearRolesForEmail,
  loadRoleAssignments,
  loadRoles,
  sortedRoles,
} from "../../../lib/roles";
import { MAX_TAGS_PER_VIEWER, getGroupMap } from "../../../lib/groups";
import { loadStaffScopes } from "../../../lib/staffScope";
import {
  isScoped,
  mayRemovePerson,
  personInScope,
  placementGroup,
  tagChangeProblem,
} from "../../../lib/staffScopeRules";
import { deleteFeedToken } from "../../../lib/feedTokens";
import { logAction } from "../../../lib/audit";
import { withMonitorApi } from "../../../lib/monitor";

// One definition, shared with /api/admin/groups' membership editor.
const MAX_TAGS = MAX_TAGS_PER_VIEWER;
const MAX_TAG_LENGTH = 30;

async function handler(req, res) {
  // Turning a group name into addresses is part of sharing, so a manager may
  // read the minimal {email, tags} projection — and only that. Roles,
  // last-seen and who-added-whom stay behind people management, as does
  // every mutation here.
  const recipientsOnly =
    req.method === "GET" && req.query.scope === "recipients";
  const access = await requireCapability(
    req,
    res,
    recipientsOnly ? CAP.SHARES_MANAGE : CAP.VIEWERS_MANAGE
  );
  if (!access) return;
  const admin = access.email;
  // Group-scoped staff (lib/staffScopeRules.js) see and manage only the
  // people in their own groups, and approve new people only into one of them.
  const scoped = isScoped(access);
  let groupMap = {};
  if (scoped) {
    try {
      groupMap = await getGroupMap();
    } catch (err) {
      console.error("Could not read groups for a scoped caller:", err);
      return res.status(502).json({ error: "Could not load viewers" });
    }
  }
  const inScope = (tags) => personInScope(access, tags, groupMap);

  if (req.method === "GET") {
    try {
      if (recipientsOnly) {
        const viewers = (await listViewers()).filter((v) => inScope(v.tags));
        return res.json({
          viewers: viewers.map((v) => ({ email: v.email, tags: v.tags })),
        });
      }
      if (scoped) {
        // Their own people only. Roles are left out: who holds what is the
        // Roles section's business, which a scoped caller cannot reach.
        const viewers = (await listViewers()).filter((v) => inScope(v.tags));
        return res.json({
          viewers: viewers.map((v) => ({ ...v, roleIds: [], envAdmin: false })),
          roles: [],
        });
      }
      // Role assignments are merged in here so the Viewers tab is one list
      // rather than two that can disagree. Staff who hold a role without
      // being on the viewer list are appended — a role grants library access
      // on its own, so hiding them from the people list would be misleading.
      const [viewers, assignments, rolesById, scopes] = await Promise.all([
        listViewers(),
        loadRoleAssignments(),
        loadRoles(),
        loadStaffScopes().catch(() => ({})),
      ]);
      const listed = new Set(viewers.map((v) => v.email));
      const withRoles = viewers.map((viewer) => ({
        ...viewer,
        roleIds: assignments[viewer.email] || [],
        envAdmin: isEnvAdmin(viewer.email),
        staffScope: scopes[viewer.email] ?? null,
      }));
      for (const [email, roleIds] of Object.entries(assignments)) {
        if (listed.has(email) || !roleIds.length) continue;
        withRoles.push({
          email,
          addedAt: null,
          addedBy: null,
          lastSeen: null,
          tags: [],
          roleIds,
          envAdmin: isEnvAdmin(email),
          staffScope: scopes[email] ?? null,
          onViewerList: false,
        });
      }
      withRoles.sort((a, b) => a.email.localeCompare(b.email));
      // The role catalog rides along so the tab can render names, not ids,
      // and so do the restricted groups someone may be limited to.
      const groupMap = await getGroupMap().catch(() => ({}));
      const limitGroups = Object.values(groupMap)
        .filter((g) => g.restricted)
        .map((g) => ({ id: g.id, name: g.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return res.json({ viewers: withRoles, roles: sortedRoles(rolesById), limitGroups });
    } catch (err) {
      console.error("Could not load viewers:", err);
      return res.status(502).json({ error: "Could not load viewers" });
    }
  }

  if (req.method === "POST") {
    const raw = req.body?.emails;
    const { valid, invalid } = parseEmailList(
      Array.isArray(raw) ? raw.join(",") : raw
    );
    if (!valid.length) {
      return res
        .status(400)
        .json({ error: "No valid email addresses found", invalid });
    }
    // A scoped caller's new viewers go into one of their groups in the same
    // write, or not at all — a viewer in no restricted group would see the
    // whole library.
    let placement;
    if (scoped) {
      const id = placementGroup(access, req.body?.group, groupMap);
      if (!id) {
        return res.status(400).json({ error: "Choose which of your groups to add them to" });
      }
      placement = { tags: [groupMap[id].name] };
    }
    let added = 0;
    try {
      added = await addViewers(valid, admin, placement);
    } catch (err) {
      console.error("Could not save viewers:", err);
      return res.status(502).json({ error: "Could not save viewers" });
    }
    if (added > 0) {
      await logAction(
        admin,
        "viewer.add",
        (added === 1 ? valid[0] : `${added} viewers`) + (placement ? ` → ${placement.tags[0]}` : "")
      );
    }
    return res.json({
      added,
      skippedExisting: valid.length - added,
      invalid,
    });
  }

  if (req.method === "PATCH") {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: "Email is required" });
    const rawTags = Array.isArray(req.body?.tags) ? req.body.tags : [];
    if (rawTags.length > MAX_TAGS) {
      return res.status(400).json({ error: `At most ${MAX_TAGS} tags per viewer` });
    }
    if (rawTags.some((t) => String(t).trim().length > MAX_TAG_LENGTH)) {
      return res
        .status(400)
        .json({ error: `Tags must be ${MAX_TAG_LENGTH} characters or fewer` });
    }
    if (scoped) {
      const current = (await listViewers()).find((v) => v.email === email);
      if (!current || !inScope(current.tags)) {
        return res.status(404).json({ error: "Viewer not found" });
      }
      const problem = tagChangeProblem(access, current.tags, rawTags, groupMap);
      if (problem) return res.status(403).json({ error: problem });
    }
    let ok;
    try {
      ok = await setViewerTags(email, rawTags);
    } catch (err) {
      console.error("Could not save viewer tags:", err);
      return res.status(502).json({ error: "Could not save viewer tags" });
    }
    if (!ok) return res.status(404).json({ error: "Viewer not found" });
    await logAction(admin, "viewer.tag", email);
    return res.json({ ok: true });
  }

  if (req.method === "DELETE") {
    const email = normalizeEmail(req.query.email);
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (email === admin) {
      return res.status(400).json({ error: "You can't remove yourself" });
    }
    if (scoped) {
      // Removing someone from the portal affects every group they are in, and
      // removing a staff member takes their roles too — neither is a scoped act
      // unless all of it is inside the scope.
      let current;
      let assignments;
      try {
        [current, assignments] = await Promise.all([
          listViewers().then((list) => list.find((v) => v.email === email)),
          loadRoleAssignments(),
        ]);
      } catch (err) {
        console.error("Could not check a scoped removal:", err);
        return res.status(502).json({ error: "Could not remove viewer" });
      }
      if (!current || !inScope(current.tags)) {
        return res.status(404).json({ error: "Viewer not found" });
      }
      if (!mayRemovePerson(access, current.tags, groupMap) || (assignments[email] || []).length) {
        return res.status(403).json({
          error: "They are also in a group outside yours, or hold a role — take them out of your group instead",
        });
      }
    }
    try {
      await removeViewer(email);
      // A role grants library access on its own (anyone holding a capability
      // is implicitly approved), so removing someone has to clear their
      // assignments too — otherwise "remove" would leave a way back in.
      await clearRolesForEmail(email);
      // Best-effort: their feed would deny on its next poll regardless,
      // because entitlement is re-resolved per fetch (lib/feedAccess.js).
      // Deleting the token anyway keeps that fact obvious rather than
      // leaving a live-looking row behind for someone to later "optimize"
      // the feed by trusting.
      await deleteFeedToken(email).catch(() => {});
    } catch (err) {
      console.error("Could not remove viewer:", err);
      return res.status(502).json({ error: "Could not remove viewer" });
    }
    await logAction(admin, "viewer.remove", email);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default withMonitorApi(handler);
