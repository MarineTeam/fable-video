// The capability catalog and the pure decision logic of the role system.
//
// Roles are admin-defined now, which makes the permission store a bigger
// prize than an env var: someone who can write it can, if the code lets them,
// write themselves more power than they were given. These tests pin the four
// properties in lib/capabilities.js that stop that.
import { describe, expect, it } from "vitest";
import {
  ALL_CAPABILITIES,
  CAP,
  CAPABILITY_INFO,
  MAX_ROLE_NAME_LENGTH,
  canDelegate,
  effectiveCapabilities,
  emailsWithCapability,
  hasAnyCapability,
  hasCapability,
  isCapability,
  isValidRoleId,
  normalizeCapabilities,
  normalizeRoleName,
  roleIdFromName,
  scopeAllows,
  undelegatableCapabilities,
} from "../capabilities";

describe("the catalog is closed (property 1)", () => {
  it("recognizes only capabilities defined in code", () => {
    expect(isCapability(CAP.ROLES_MANAGE)).toBe(true);
    expect(isCapability("videos.destroy-everything")).toBe(false);
    expect(isCapability("")).toBe(false);
    expect(isCapability(undefined)).toBe(false);
  });

  it("labels every capability it defines, so none reaches the UI unnamed", () => {
    expect(CAPABILITY_INFO.map((i) => i.cap).sort()).toEqual([...ALL_CAPABILITIES].sort());
  });

  it("drops unknown strings, dedupes and sorts on normalize", () => {
    expect(
      normalizeCapabilities(["videos.read", "nope", "audit.read", "videos.read"])
    ).toEqual(["audit.read", "videos.read"]);
  });

  it("treats a non-array as no capabilities", () => {
    expect(normalizeCapabilities(null)).toEqual([]);
    expect(normalizeCapabilities("roles.manage")).toEqual([]);
    expect(normalizeCapabilities({ 0: "roles.manage" })).toEqual([]);
  });
});

describe("effectiveCapabilities", () => {
  it("returns a sorted list whichever branch produced it", () => {
    const owner = effectiveCapabilities({ owner: true });
    expect(owner).toEqual([...owner].sort());
  });

  const rolesById = {
    editor: { id: "editor", name: "Editor", capabilities: [CAP.VIDEOS_READ, CAP.VIDEOS_MANAGE] },
    auditor: { id: "auditor", name: "Auditor", capabilities: [CAP.AUDIT_READ] },
    // A record hand-edited in Redis to claim something outside the catalog.
    forged: { id: "forged", name: "Forged", capabilities: ["videos.read", "god.mode"] },
  };

  // Property 2: the owner set never depends on stored data.
  it("gives an owner the whole catalog without consulting any stored role", () => {
    expect(effectiveCapabilities({ owner: true, roleIds: [], rolesById: {} })).toEqual(
      [...ALL_CAPABILITIES].sort()
    );
  });

  it("unions the capabilities of a non-owner's roles", () => {
    expect(
      effectiveCapabilities({ owner: false, roleIds: ["editor", "auditor"], rolesById })
    ).toEqual([CAP.AUDIT_READ, CAP.VIDEOS_MANAGE, CAP.VIDEOS_READ]);
  });

  // The forged-record case: Redis is admin-writable, so a stored capability
  // string outside the catalog must grant nothing.
  it("ignores capability strings outside the catalog, even when stored", () => {
    expect(effectiveCapabilities({ owner: false, roleIds: ["forged"], rolesById })).toEqual([
      CAP.VIDEOS_READ,
    ]);
  });

  it("contributes nothing for a role id with no surviving record", () => {
    expect(effectiveCapabilities({ owner: false, roleIds: ["deleted"], rolesById })).toEqual([]);
  });

  it("gives nothing to someone with no roles", () => {
    expect(effectiveCapabilities({ owner: false, roleIds: [], rolesById })).toEqual([]);
    expect(effectiveCapabilities({})).toEqual([]);
  });
});

// Property 3. This is the whole reason delegating roles.manage is safe.
describe("no self-escalation", () => {
  const manager = [CAP.VIDEOS_READ, CAP.VIDEOS_MANAGE, CAP.ROLES_MANAGE];

  it("lets an actor hand out exactly what they hold", () => {
    expect(canDelegate(manager, [CAP.VIDEOS_READ])).toBe(true);
    expect(canDelegate(manager, manager)).toBe(true);
    expect(canDelegate(manager, [])).toBe(true);
  });

  it("refuses anything they do not hold", () => {
    expect(canDelegate(manager, [CAP.SETTINGS_MANAGE])).toBe(false);
    expect(canDelegate(manager, [CAP.VIDEOS_READ, CAP.SETTINGS_MANAGE])).toBe(false);
  });

  it("names which capabilities were refused, for a 403 that explains itself", () => {
    expect(
      undelegatableCapabilities(manager, [CAP.VIDEOS_READ, CAP.SETTINGS_MANAGE, CAP.AUDIT_READ])
    ).toEqual([CAP.AUDIT_READ, CAP.SETTINGS_MANAGE]);
  });

  it("cannot be talked round with an uncatalogued capability", () => {
    expect(canDelegate(manager, ["god.mode"])).toBe(true); // dropped, so nothing is granted
    expect(undelegatableCapabilities(manager, ["god.mode"])).toEqual([]);
    expect(normalizeCapabilities(["god.mode"])).toEqual([]);
  });

  it("holds for an actor with nothing", () => {
    expect(canDelegate([], [CAP.VIDEOS_READ])).toBe(false);
    expect(canDelegate(undefined, [CAP.VIDEOS_READ])).toBe(false);
  });
});

describe("hasCapability / hasAnyCapability", () => {
  const access = { email: "x@y.z", capabilities: [CAP.VIDEOS_READ] };

  it("reads either a resolved access record or a raw array", () => {
    expect(hasCapability(access, CAP.VIDEOS_READ)).toBe(true);
    expect(hasCapability([CAP.VIDEOS_READ], CAP.VIDEOS_READ)).toBe(true);
    expect(hasCapability(access, CAP.SETTINGS_MANAGE)).toBe(false);
  });

  it("is false for a missing or malformed record rather than throwing", () => {
    for (const bad of [null, undefined, {}, { capabilities: "nope" }, 42]) {
      expect(hasCapability(bad, CAP.VIDEOS_READ)).toBe(false);
      expect(hasAnyCapability(bad)).toBe(false);
    }
  });

  // "Staff" is now "holds at least one capability", replacing isStaffRole.
  it("treats anyone with at least one capability as staff", () => {
    expect(hasAnyCapability(access)).toBe(true);
    expect(hasAnyCapability({ capabilities: [] })).toBe(false);
  });
});

describe("emailsWithCapability", () => {
  const rolesById = {
    people: { id: "people", name: "People", capabilities: [CAP.VIEWERS_MANAGE] },
    media: { id: "media", name: "Media", capabilities: [CAP.VIDEOS_MANAGE] },
  };
  const assignments = { "boss@example.com": ["people"], "mate@example.com": ["media"] };

  it("includes owners unconditionally — they hold the whole catalog", () => {
    expect(
      emailsWithCapability({
        owners: ["root@example.com"],
        assignments,
        rolesById,
        cap: CAP.VIEWERS_MANAGE,
      })
    ).toEqual(["boss@example.com", "root@example.com"]);
  });

  it("returns a different set for a different capability", () => {
    expect(
      emailsWithCapability({ owners: [], assignments, rolesById, cap: CAP.VIDEOS_MANAGE })
    ).toEqual(["mate@example.com"]);
  });

  it("returns just the owners when nobody else holds it", () => {
    expect(
      emailsWithCapability({
        owners: ["root@example.com"],
        assignments,
        rolesById,
        cap: CAP.SETTINGS_MANAGE,
      })
    ).toEqual(["root@example.com"]);
  });
});

describe("role names and ids", () => {
  it("collapses whitespace and clamps the name", () => {
    expect(normalizeRoleName("  Media   team ")).toBe("Media team");
    expect(normalizeRoleName("x".repeat(200))).toHaveLength(MAX_ROLE_NAME_LENGTH);
    expect(normalizeRoleName("   ")).toBeNull();
    expect(normalizeRoleName(null)).toBeNull();
  });

  it("slugs an id from the name with a suffix, so alike names never collide", () => {
    expect(roleIdFromName("Media team", () => "abc123")).toBe("media-team-abc123");
    expect(roleIdFromName("!!!", () => "abc123")).toBe("role-abc123");
    expect(roleIdFromName("Media team", () => "aaa")).not.toBe(
      roleIdFromName("Media team", () => "bbb")
    );
  });

  // Load-bearing: a role id must never look like an email, or it could collide
  // with a leftover legacy row in the same hash (see roleMigration.test.js).
  it("never accepts an id containing @ or .", () => {
    expect(isValidRoleId("media-team-abc123")).toBe(true);
    expect(isValidRoleId("someone@example.com")).toBe(false);
    expect(isValidRoleId("a.b")).toBe(false);
    expect(isValidRoleId("-leading")).toBe(false);
    expect(isValidRoleId("")).toBe(false);
    expect(isValidRoleId(null)).toBe(false);
    expect(isValidRoleId("x".repeat(49))).toBe(false);
  });
});

// Group scoping is a separate axis from capabilities and survives the move to
// custom roles unchanged: it answers WHICH videos, not WHAT actions.
describe("scopeAllows", () => {
  it("treats null and undefined as unrestricted", () => {
    expect(scopeAllows(null, "v1")).toBe(true);
    expect(scopeAllows(undefined, "v1")).toBe(true);
  });

  it("treats an empty array as nothing permitted — never the same as null", () => {
    expect(scopeAllows([], "v1")).toBe(false);
  });

  it("permits only the listed ids", () => {
    expect(scopeAllows(["v1"], "v1")).toBe(true);
    expect(scopeAllows(["v1"], "v2")).toBe(false);
  });
});
