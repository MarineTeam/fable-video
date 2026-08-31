import { describe, expect, it } from "vitest";
import {
  CAP,
  DEFAULT_ROLE,
  ROLES,
  clampRole,
  hasCapability,
  isRole,
  isStaffRole,
  roleCapabilities,
  roleHasCapability,
  scopeAllows,
} from "../roles";

describe("clampRole", () => {
  it("accepts the known roles, case- and whitespace-insensitively", () => {
    expect(clampRole("admin")).toBe("admin");
    expect(clampRole("  Manager ")).toBe("manager");
    expect(clampRole("VIEWER")).toBe("viewer");
  });

  // A hand-edited or half-written Redis value must never grant more than the
  // default — this is the fail-closed property at the value level.
  it("degrades anything unrecognized to the least privileged role", () => {
    expect(clampRole("superadmin")).toBe(DEFAULT_ROLE);
    expect(clampRole("")).toBe(DEFAULT_ROLE);
    expect(clampRole(null)).toBe(DEFAULT_ROLE);
    expect(clampRole(undefined)).toBe(DEFAULT_ROLE);
    expect(clampRole({ role: "admin" })).toBe(DEFAULT_ROLE);
  });

  it("recognizes exactly the documented role set", () => {
    expect(ROLES).toEqual(["viewer", "manager", "admin"]);
    expect(isRole("admin")).toBe(true);
    expect(isRole("owner")).toBe(false);
  });
});

describe("roleCapabilities", () => {
  it("gives a plain viewer no admin capability at all", () => {
    expect(roleCapabilities("viewer")).toEqual([]);
    expect(isStaffRole("viewer")).toBe(false);
  });

  it("lets a manager run the library and sharing but not people or settings", () => {
    expect(roleHasCapability("manager", CAP.VIDEOS)).toBe(true);
    expect(roleHasCapability("manager", CAP.SHARES)).toBe(true);
    expect(roleHasCapability("manager", CAP.INSIGHTS)).toBe(true);
    expect(roleHasCapability("manager", CAP.PEOPLE)).toBe(false);
    expect(roleHasCapability("manager", CAP.SETTINGS)).toBe(false);
    expect(isStaffRole("manager")).toBe(true);
  });

  it("gives an admin every capability", () => {
    for (const capability of Object.values(CAP)) {
      expect(roleHasCapability("admin", capability)).toBe(true);
    }
    expect(isStaffRole("admin")).toBe(true);
  });

  it("keeps each role a strict superset of the one below it", () => {
    const viewer = roleCapabilities("viewer");
    const manager = roleCapabilities("manager");
    const admin = roleCapabilities("admin");
    expect(viewer.every((c) => manager.includes(c))).toBe(true);
    expect(manager.every((c) => admin.includes(c))).toBe(true);
    expect(admin.length).toBeGreaterThan(manager.length);
  });

  it("grants nothing for an unknown role", () => {
    expect(roleCapabilities("wizard")).toEqual([]);
    expect(roleHasCapability("wizard", CAP.VIDEOS)).toBe(false);
  });
});

describe("hasCapability", () => {
  it("reads the capability list off a resolved access record", () => {
    const access = { capabilities: [CAP.VIDEOS] };
    expect(hasCapability(access, CAP.VIDEOS)).toBe(true);
    expect(hasCapability(access, CAP.PEOPLE)).toBe(false);
  });

  // A denied resolveAccess result is `{ capabilities: [] }`; a thrown-away
  // one may be null. Neither may authorize anything.
  it("denies on a missing or empty access record", () => {
    expect(hasCapability(null, CAP.VIDEOS)).toBe(false);
    expect(hasCapability(undefined, CAP.VIDEOS)).toBe(false);
    expect(hasCapability({}, CAP.VIDEOS)).toBe(false);
    expect(hasCapability({ capabilities: [] }, CAP.VIDEOS)).toBe(false);
  });
});

describe("scopeAllows", () => {
  it("allows everything when the scope is unrestricted", () => {
    expect(scopeAllows(null, "abc")).toBe(true);
    expect(scopeAllows(undefined, "abc")).toBe(true);
  });

  it("allows only the listed ids when restricted", () => {
    expect(scopeAllows(["a", "b"], "a")).toBe(true);
    expect(scopeAllows(["a", "b"], "c")).toBe(false);
  });

  // The fail-closed result from resolveAccess is an empty array, which must
  // deny every video rather than being mistaken for "unrestricted".
  it("denies everything for an empty scope", () => {
    expect(scopeAllows([], "a")).toBe(false);
  });
});
