// resolveAccess is the single decision point for "who is this and what may
// they see". These tests exercise the resolver directly with Redis stubbed —
// the fail-closed paths in particular, which are the ones that leak the
// private library if they ever regress.
//
// Under custom roles there is no role name to assert on any more, so the
// assertions are about capabilities, the staff flag, and group video scope.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hget = vi.fn();
const hgetall = vi.fn();

vi.mock("../redis", () => ({
  k: (...parts) => ["fablevideo", ...parts].join(":"),
  redis: () => ({ hget, hgetall }),
}));

const { emailsHoldingCapability, resolveAccess } = await import("../roles");
const { ALL_CAPABILITIES, CAP } = await import("../capabilities");

const MEDIA = {
  id: "media-abc",
  name: "Media",
  capabilities: [CAP.VIDEOS_READ, CAP.VIDEOS_MANAGE],
};

// Describes the whole stored world for one test.
function stub({
  roleIds = null,
  rolesById = {},
  viewerMeta = null,
  groups = {},
  legacyRole = null,
} = {}) {
  hget.mockImplementation(async (key, field) => {
    // The legacy fixed-role row and the new role records share k("roles").
    if (key === "fablevideo:roles") return legacyRole;
    if (key === "fablevideo:user:roles") return roleIds;
    if (key === "fablevideo:viewers") return viewerMeta;
    return null;
  });
  hgetall.mockImplementation(async (key) => {
    if (key === "fablevideo:roles") return rolesById;
    if (key === "fablevideo:groups") return groups;
    return {};
  });
}

beforeEach(() => {
  process.env.ADMIN_EMAILS = "root@example.com";
  hget.mockReset();
  hgetall.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("owners (ADMIN_EMAILS)", () => {
  it("gets the whole catalog without touching Redis at all", async () => {
    stub();
    const access = await resolveAccess("root@example.com");
    expect(access.owner).toBe(true);
    expect(access.staff).toBe(true);
    expect(access.approved).toBe(true);
    expect(access.capabilities).toEqual([...ALL_CAPABILITIES].sort());
    expect(access.videoScope).toBe(null);
    expect(hget).not.toHaveBeenCalled();
    expect(hgetall).not.toHaveBeenCalled();
  });

  // The recovery path: this is why ADMIN_EMAILS exists at all.
  it("stays an owner even when every Redis read throws", async () => {
    hget.mockRejectedValue(new Error("redis is down"));
    hgetall.mockRejectedValue(new Error("redis is down"));
    const access = await resolveAccess("root@example.com");
    expect(access.owner).toBe(true);
    expect(access.capabilities).toEqual([...ALL_CAPABILITIES].sort());
  });

  it("is case- and whitespace-insensitive about the address", async () => {
    stub();
    expect((await resolveAccess("  Root@Example.COM ")).owner).toBe(true);
  });
});

describe("role holders", () => {
  it("unions the capabilities of the roles they hold", async () => {
    stub({ roleIds: ["media-abc"], rolesById: { "media-abc": MEDIA } });
    const access = await resolveAccess("mate@example.com");
    expect(access.capabilities).toEqual([CAP.VIDEOS_MANAGE, CAP.VIDEOS_READ]);
    expect(access.staff).toBe(true);
    // A role grants library access on its own, without a viewer-list row.
    expect(access.approved).toBe(true);
    expect(access.videoScope).toBe(null);
  });

  it("is not an owner, however many capabilities it adds up to", async () => {
    const everything = { id: "all", name: "All", capabilities: [...ALL_CAPABILITIES] };
    stub({ roleIds: ["all"], rolesById: { all: everything } });
    const access = await resolveAccess("mate@example.com");
    expect(access.capabilities).toEqual([...ALL_CAPABILITIES].sort());
    expect(access.owner).toBe(false);
  });

  it("gets nothing from a role id with no surviving record", async () => {
    stub({ roleIds: ["deleted-role"], rolesById: {} });
    const access = await resolveAccess("mate@example.com");
    expect(access.capabilities).toEqual([]);
    expect(access.approved).toBe(false);
  });
});

describe("plain viewers", () => {
  it("is approved by the viewer list with no capabilities", async () => {
    stub({ viewerMeta: { addedAt: "x", tags: [] } });
    const access = await resolveAccess("crew@example.com");
    expect(access.approved).toBe(true);
    expect(access.staff).toBe(false);
    expect(access.capabilities).toEqual([]);
    expect(access.videoScope).toBe(null);
  });

  it("is scoped by a restricted group", async () => {
    stub({
      viewerMeta: { addedAt: "x", tags: ["Team A"] },
      groups: { "team a": { restricted: true, videoIds: ["v1"] } },
    });
    expect((await resolveAccess("crew@example.com")).videoScope).toEqual(["v1"]);
  });

  it("is denied outright when on neither list", async () => {
    stub();
    const access = await resolveAccess("stranger@example.com");
    expect(access.approved).toBe(false);
    expect(access.capabilities).toEqual([]);
    expect(access.videoScope).toEqual([]);
  });

  it("never scopes staff by group, even when tagged into a restricted one", async () => {
    stub({
      roleIds: ["media-abc"],
      rolesById: { "media-abc": MEDIA },
      viewerMeta: { addedAt: "x", tags: ["Team A"] },
      groups: { "team a": { restricted: true, videoIds: ["v1"] } },
    });
    expect((await resolveAccess("mate@example.com")).videoScope).toBe(null);
  });
});

describe("fails closed", () => {
  it("denies everything when the lookup throws", async () => {
    hget.mockRejectedValue(new Error("redis is down"));
    hgetall.mockRejectedValue(new Error("redis is down"));
    const access = await resolveAccess("crew@example.com");
    expect(access.approved).toBe(false);
    expect(access.capabilities).toEqual([]);
    expect(access.videoScope).toEqual([]);
  });

  // An empty scope means "nothing permitted" and must never be normalized to
  // null, which means "unrestricted" — architecture-contract invariant (c).
  it("gives an approved viewer an EMPTY scope when groups are unreadable", async () => {
    hget.mockImplementation(async (key) =>
      key === "fablevideo:viewers" ? { addedAt: "x", tags: ["Team A"] } : null
    );
    hgetall.mockImplementation(async (key) => {
      if (key === "fablevideo:groups") throw new Error("redis is down");
      return {};
    });
    const access = await resolveAccess("crew@example.com");
    expect(access.approved).toBe(true);
    expect(access.videoScope).toEqual([]);
    expect(access.videoScope).not.toBe(null);
  });

  it("rejects a blank address without touching Redis", async () => {
    stub();
    expect((await resolveAccess("")).approved).toBe(false);
    expect((await resolveAccess(null)).approved).toBe(false);
    expect(hget).not.toHaveBeenCalled();
  });
});

// The migration's read-time fallback, seen from the resolver: somebody whose
// fixed-role row has not been converted yet must still work.
describe("un-migrated fixed-role rows", () => {
  it("resolves a legacy admin to their old capabilities", async () => {
    stub({ legacyRole: "admin" });
    const access = await resolveAccess("boss@example.com");
    expect(access.staff).toBe(true);
    expect(access.approved).toBe(true);
    expect(access.capabilities).toContain(CAP.SETTINGS_MANAGE);
    expect(access.capabilities).toContain(CAP.VIEWERS_MANAGE);
  });

  it("resolves a legacy manager without people or settings", async () => {
    stub({ legacyRole: "manager" });
    const access = await resolveAccess("mate@example.com");
    expect(access.capabilities).toContain(CAP.VIDEOS_MANAGE);
    expect(access.capabilities).not.toContain(CAP.SETTINGS_MANAGE);
  });

  // The new model wins: once converted, the fallback must not add anything.
  it("prefers a real assignment over the legacy row", async () => {
    stub({
      roleIds: ["media-abc"],
      rolesById: { "media-abc": MEDIA },
      legacyRole: "admin",
    });
    const access = await resolveAccess("boss@example.com");
    expect(access.capabilities).toEqual([CAP.VIDEOS_MANAGE, CAP.VIDEOS_READ]);
    expect(access.capabilities).not.toContain(CAP.SETTINGS_MANAGE);
  });
});

describe("emailsHoldingCapability", () => {
  it("returns the owners plus everyone whose roles include it", async () => {
    process.env.ADMIN_EMAILS = "root@example.com";
    hgetall.mockImplementation(async (key) => {
      if (key === "fablevideo:roles") {
        return {
          people: { id: "people", name: "People", capabilities: [CAP.VIEWERS_MANAGE] },
          "media-abc": MEDIA,
        };
      }
      if (key === "fablevideo:user:roles") {
        return { "boss@example.com": ["people"], "mate@example.com": ["media-abc"] };
      }
      return {};
    });
    expect(await emailsHoldingCapability(CAP.VIEWERS_MANAGE)).toEqual([
      "boss@example.com",
      "root@example.com",
    ]);
    expect(await emailsHoldingCapability(CAP.VIDEOS_MANAGE)).toEqual([
      "mate@example.com",
      "root@example.com",
    ]);
  });

  // Telling fewer of the right people beats telling nobody: this is a
  // notification convenience, not an authorization decision.
  it("degrades to the owner list when the role data cannot be read", async () => {
    hgetall.mockRejectedValue(new Error("redis is down"));
    expect(await emailsHoldingCapability(CAP.VIEWERS_MANAGE)).toEqual(["root@example.com"]);
  });
});
