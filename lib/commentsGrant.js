// A one-time grant, decided by the owner (2026-10-11): every role that can
// manage viewers may also remove any viewer's comment (CAP.COMMENTS_MANAGE).
//
// One-time on purpose. It runs once per deployment's Redis — the first time
// a staff member opens /admin or the Roles tab — and then records that it ran,
// so taking the capability back off a role later sticks rather than being
// re-added on the next page load. A role created or edited afterwards gets
// whatever its editor ticks, like any other capability.
//
// Best-effort: a failure is logged by the caller and retried on the next load,
// because the marker is written only after every role has been saved.
import { k, redis } from "./redis";
import { CAP } from "./capabilities";
import { loadRoles, saveRole } from "./roles";

const MARKER = () => k("migration", "comments-manage-for-viewer-managers");

// Pure: the roles the grant would change.
export function rolesNeedingCommentModeration(rolesById) {
  return Object.values(rolesById || {}).filter(
    (role) =>
      Array.isArray(role?.capabilities) &&
      role.capabilities.includes(CAP.VIEWERS_MANAGE) &&
      !role.capabilities.includes(CAP.COMMENTS_MANAGE)
  );
}

// Returns the names of the roles it changed ([] once it has run).
export async function grantCommentModeration() {
  const r = redis();
  if (await r.get(MARKER())) return [];
  const changed = rolesNeedingCommentModeration(await loadRoles());
  for (const role of changed) {
    const result = await saveRole({ ...role, capabilities: [...role.capabilities, CAP.COMMENTS_MANAGE] });
    if (!result.ok) throw new Error(`Could not update role ${role.id}: ${result.error}`);
  }
  await r.set(MARKER(), new Date().toISOString());
  return changed.map((role) => role.name).sort();
}
