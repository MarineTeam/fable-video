// The migration from the fixed viewer/manager/admin model to custom roles.
//
// The hazard being tested: both models use k("roles"), with incompatible
// contents. Port the code without this file and the deploy silently demotes
// every Redis-promoted admin — no error, no log, just people who could do
// things yesterday and can't today. These tests pin that it does not happen.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hget = vi.fn();
const hgetall = vi.fn();
const hset = vi.fn();
const hdel = vi.fn();

vi.mock("../redis", () => ({
  k: (...parts) => ["fablevideo", ...parts].join(":"),
  redis: () => ({ hget, hgetall, hset, hdel }),
}));

const {
  LEGACY_ROLE_IDS,
  capabilitiesForLegacyRole,
  findLegacyAssignments,
  isLegacyRoleEntry,
  legacyCapabilitiesFor,
  migrateLegacyRoles,
} = await import("../roleMigration");
const { CAP } = await import("../capabilities");

const ROLES = "fablevideo:roles";
const USER_ROLES = "fablevideo:user:roles";

beforeEach(() => {
  vi.clearAllMocks();
  hget.mockResolvedValue(null);
  hgetall.mockResolvedValue({});
  hset.mockResolvedValue(1);
  hdel.mockResolvedValue(1);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("telling the two shapes apart", () => {
  it("recognizes a legacy row: an email field holding a role-name string", () => {
    expect(isLegacyRoleEntry("someone@example.com", "admin")).toBe(true);
    expect(isLegacyRoleEntry("someone@example.com", "manager")).toBe(true);
    expect(isLegacyRoleEntry("someone@example.com", " Admin ")).toBe(true);
  });

  // The other direction matters just as much: a new role record must never be
  // mistaken for a legacy row and deleted.
  it("never mistakes a new-model role record for a legacy row", () => {
    expect(
      isLegacyRoleEntry("media-team-abc123", { id: "media-team-abc123", name: "Media" })
    ).toBe(false);
    expect(isLegacyRoleEntry("media-team-abc123", "admin")).toBe(false);
    expect(isLegacyRoleEntry("someone@example.com", { name: "Media" })).toBe(false);
    expect(isLegacyRoleEntry("someone@example.com", "viewer")).toBe(false);
    expect(isLegacyRoleEntry("someone@example.com", "superadmin")).toBe(false);
  });
});

describe("the legacy capability mapping", () => {
  // Generous rather than minimal on purpose: anything someone could do
  // yesterday they must still be able to do, or the migration is a silent
  // permission cut.
  it("keeps a manager's library, sharing and insight access", () => {
    const caps = capabilitiesForLegacyRole("manager");
    expect(caps).toContain(CAP.VIDEOS_MANAGE);
    expect(caps).toContain(CAP.VIDEOS_UPLOAD);
    expect(caps).toContain(CAP.SHARES_MANAGE);
    expect(caps).toContain(CAP.ANALYTICS_READ);
    expect(caps).toContain(CAP.AUDIT_READ);
    // ...and none of what a manager never had.
    expect(caps).not.toContain(CAP.VIEWERS_MANAGE);
    expect(caps).not.toContain(CAP.SETTINGS_MANAGE);
    expect(caps).not.toContain(CAP.ROLES_MANAGE);
  });

  it("keeps an admin's everything, including roles and broadcasts", () => {
    const caps = capabilitiesForLegacyRole("admin");
    for (const cap of capabilitiesForLegacyRole("manager")) expect(caps).toContain(cap);
    expect(caps).toContain(CAP.VIEWERS_MANAGE);
    expect(caps).toContain(CAP.SETTINGS_MANAGE);
    expect(caps).toContain(CAP.ROLES_MANAGE);
    expect(caps).toContain(CAP.GROUPS_MANAGE);
    expect(caps).toContain(CAP.BROADCAST_SEND);
  });

  it("maps a plain viewer, and anything unrecognized, to nothing", () => {
    expect(capabilitiesForLegacyRole("viewer")).toEqual([]);
    expect(capabilitiesForLegacyRole("superadmin")).toEqual([]);
    expect(capabilitiesForLegacyRole(null)).toEqual([]);
  });
});

// Half 1: nobody is locked out between deploy and migration.
describe("the read-time fallback", () => {
  it("resolves an un-migrated admin to the admin capability set", async () => {
    hget.mockResolvedValue("admin");
    const caps = await legacyCapabilitiesFor("boss@example.com");
    expect(caps).toContain(CAP.SETTINGS_MANAGE);
    expect(hget).toHaveBeenCalledWith(ROLES, "boss@example.com");
  });

  it("normalizes the address before looking it up", async () => {
    hget.mockResolvedValue("manager");
    await legacyCapabilitiesFor("  Boss@Example.COM ");
    expect(hget).toHaveBeenCalledWith(ROLES, "boss@example.com");
  });

  it("returns nothing once the legacy row is gone", async () => {
    hget.mockResolvedValue(null);
    expect(await legacyCapabilitiesFor("boss@example.com")).toEqual([]);
  });

  // It sits on an authorization path, so it fails closed like everything else
  // there — an unreadable Redis never invents capabilities.
  it("returns nothing when Redis throws", async () => {
    hget.mockRejectedValue(new Error("redis is down"));
    expect(await legacyCapabilitiesFor("boss@example.com")).toEqual([]);
  });

  it("ignores a value that is a new-model role record, not a legacy name", async () => {
    hget.mockResolvedValue({ id: "x", name: "Media", capabilities: [] });
    expect(await legacyCapabilitiesFor("boss@example.com")).toEqual([]);
  });
});

// Half 2: the conversion itself.
describe("migrateLegacyRoles", () => {
  it("does nothing, and writes nothing, when there is no legacy data", async () => {
    hgetall.mockResolvedValue({
      "media-team-abc": { id: "media-team-abc", name: "Media", capabilities: [] },
    });
    const result = await migrateLegacyRoles();
    expect(result.migrated).toBe(0);
    expect(hset).not.toHaveBeenCalled();
    expect(hdel).not.toHaveBeenCalled();
  });

  it("creates the role records, assigns them, then clears the legacy rows", async () => {
    hgetall.mockImplementation(async (key) =>
      key === ROLES
        ? { "boss@example.com": "admin", "mate@example.com": "manager" }
        : {}
    );

    const result = await migrateLegacyRoles();
    expect(result.migrated).toBe(2);
    expect(result.roles).toEqual(["Admin", "Manager"]);

    const roleWrite = hset.mock.calls.find(([key]) => key === ROLES)[1];
    expect(Object.keys(roleWrite).sort()).toEqual(
      [LEGACY_ROLE_IDS.admin, LEGACY_ROLE_IDS.manager].sort()
    );
    expect(roleWrite[LEGACY_ROLE_IDS.admin].capabilities).toContain(CAP.SETTINGS_MANAGE);

    const assignWrite = hset.mock.calls.find(([key]) => key === USER_ROLES)[1];
    expect(assignWrite["boss@example.com"]).toEqual([LEGACY_ROLE_IDS.admin]);
    expect(assignWrite["mate@example.com"]).toEqual([LEGACY_ROLE_IDS.manager]);

    expect(hdel).toHaveBeenCalledWith(ROLES, "boss@example.com", "mate@example.com");
  });

  // The fail-safe ordering: a crash mid-way leaves someone holding BOTH the
  // legacy row and the new assignment (same capabilities either way) rather
  // than neither.
  it("writes the roles and assignments before deleting anything", async () => {
    hgetall.mockImplementation(async (key) =>
      key === ROLES ? { "boss@example.com": "admin" } : {}
    );
    const order = [];
    hset.mockImplementation(async (key) => {
      order.push(`set:${key}`);
      return 1;
    });
    hdel.mockImplementation(async (key) => {
      order.push(`del:${key}`);
      return 1;
    });
    await migrateLegacyRoles();
    expect(order).toEqual([`set:${ROLES}`, `set:${USER_ROLES}`, `del:${ROLES}`]);
  });

  it("merges with an existing new-model assignment rather than replacing it", async () => {
    hgetall.mockImplementation(async (key) => {
      if (key === ROLES) return { "boss@example.com": "admin" };
      if (key === USER_ROLES) return { "boss@example.com": ["media-team-abc"] };
      return {};
    });
    await migrateLegacyRoles();
    const assignWrite = hset.mock.calls.find(([key]) => key === USER_ROLES)[1];
    expect(assignWrite["boss@example.com"]).toEqual(
      [LEGACY_ROLE_IDS.admin, "media-team-abc"].sort()
    );
  });

  it("only creates the roles actually in use", async () => {
    hgetall.mockImplementation(async (key) =>
      key === ROLES ? { "mate@example.com": "manager" } : {}
    );
    const result = await migrateLegacyRoles();
    expect(result.roles).toEqual(["Manager"]);
    const roleWrite = hset.mock.calls.find(([key]) => key === ROLES)[1];
    expect(Object.keys(roleWrite)).toEqual([LEGACY_ROLE_IDS.manager]);
  });

  // Idempotent: the Roles tab runs it on every load.
  it("is a no-op the second time, because the legacy rows are gone", async () => {
    let rolesHash = { "boss@example.com": "admin" };
    hgetall.mockImplementation(async (key) => (key === ROLES ? rolesHash : {}));
    hdel.mockImplementation(async (key, ...fields) => {
      if (key === ROLES) for (const f of fields) delete rolesHash[f];
      return 1;
    });

    expect((await migrateLegacyRoles()).migrated).toBe(1);
    hset.mockClear();
    hdel.mockClear();
    expect((await migrateLegacyRoles()).migrated).toBe(0);
    expect(hset).not.toHaveBeenCalled();
  });

  it("leaves a plain viewer row alone — it already meant no role", async () => {
    hgetall.mockImplementation(async (key) =>
      key === ROLES ? { "crew@example.com": "viewer" } : {}
    );
    const result = await migrateLegacyRoles();
    expect(result.migrated).toBe(0);
    expect(hdel).not.toHaveBeenCalled();
  });
});

describe("findLegacyAssignments", () => {
  it("reports only the legacy rows, normalized, ignoring real role records", async () => {
    hgetall.mockResolvedValue({
      "Boss@Example.com": "admin",
      "media-team-abc": { id: "media-team-abc", name: "Media", capabilities: [] },
      "crew@example.com": "viewer",
    });
    expect(await findLegacyAssignments()).toEqual({ "boss@example.com": "admin" });
  });
});
