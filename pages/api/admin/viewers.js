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
import { deleteFeedToken } from "../../../lib/feedTokens";
import { logAction } from "../../../lib/audit";
import { withMonitorApi } from "../../../lib/monitor";

const MAX_TAGS = 20;
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

  if (req.method === "GET") {
    try {
      if (recipientsOnly) {
        const viewers = await listViewers();
        return res.json({
          viewers: viewers.map((v) => ({ email: v.email, tags: v.tags })),
        });
      }
      // Role assignments are merged in here so the Viewers tab is one list
      // rather than two that can disagree. Staff who hold a role without
      // being on the viewer list are appended — a role grants library access
      // on its own, so hiding them from the people list would be misleading.
      const [viewers, assignments, rolesById] = await Promise.all([
        listViewers(),
        loadRoleAssignments(),
        loadRoles(),
      ]);
      const listed = new Set(viewers.map((v) => v.email));
      const withRoles = viewers.map((viewer) => ({
        ...viewer,
        roleIds: assignments[viewer.email] || [],
        envAdmin: isEnvAdmin(viewer.email),
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
          onViewerList: false,
        });
      }
      withRoles.sort((a, b) => a.email.localeCompare(b.email));
      // The role catalog rides along so the tab can render names, not ids.
      return res.json({ viewers: withRoles, roles: sortedRoles(rolesById) });
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
    let added = 0;
    try {
      added = await addViewers(valid, admin);
    } catch (err) {
      console.error("Could not save viewers:", err);
      return res.status(502).json({ error: "Could not save viewers" });
    }
    if (added > 0) {
      await logAction(
        admin,
        "viewer.add",
        added === 1 ? valid[0] : `${added} viewers`
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
