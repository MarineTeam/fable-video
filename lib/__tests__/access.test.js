// resolveAccess is the single decision point for "who is this and what may
// they see". API routes have no automated coverage in this repo, so these
// tests exercise the resolver directly with Redis stubbed — the fail-closed
// paths in particular, which are the ones that leak the private library if
// they ever regress.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hget = vi.fn();
const hgetall = vi.fn();

vi.mock("../redis", () => ({
  k: (...parts) => ["fablevideo", ...parts].join(":"),
  redis: () => ({ hget, hgetall }),
}));

const { resolveAccess } = await import("../roles");
const { CAP } = await import("../capabilities");

// hget is shared by the roles hash and the viewers hash; route by key.
function stub({ role = null, viewerMeta = null, groups = {} } = {}) {
  hget.mockImplementation(async (key) => {
    if (key === "fablevideo:roles") return role;
    if (key === "fablevideo:viewers") return viewerMeta;
    if (key === "fablevideo:groups") return null;
    return null;
  });
  hgetall.mockImplementation(async (key) =>
    key === "fablevideo:groups" ? groups : {}
  );
}

beforeEach(() => {
  process.env.ADMIN_EMAILS = "root@example.com";
  hget.mockReset();
  hgetall.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveAccess — the ADMIN_EMAILS bootstrap seed", () => {
  it("makes an env admin a full admin without touching Redis", async () => {
    stub();
    const access = await resolveAccess("Root@Example.com");
    expect(access.role).toBe("admin");
    expect(access.approved).toBe(true);
    expect(access.videoScope).toBe(null);
    expect(access.capabilities).toContain(CAP.PEOPLE);
    // The recovery path: an env admin must resolve even if Redis is down.
    expect(hget).not.toHaveBeenCalled();
    expect(hgetall).not.toHaveBeenCalled();
  });

  it("keeps an env admin an admin even if Redis says they are a viewer", async () => {
    stub({ role: "viewer" });
    const access = await resolveAccess("root@example.com");
    expect(access.role).toBe("admin");
  });
});

describe("resolveAccess — fail-closed behavior", () => {
  it("denies everything when the role/viewer lookup throws", async () => {
    hget.mockRejectedValue(new Error("redis down"));
    hgetall.mockRejectedValue(new Error("redis down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const access = await resolveAccess("someone@example.com");
    expect(access.approved).toBe(false);
    expect(access.role).toBe("viewer");
    expect(access.capabilities).toEqual([]);
    // An empty array, never null — null would mean "unrestricted".
    expect(access.videoScope).toEqual([]);
  });

  it("denies a viewer's videos when the group lookup throws", async () => {
    hget.mockImplementation(async (key) => {
      if (key === "fablevideo:roles") return null;
      if (key === "fablevideo:viewers") return { addedAt: "x", tags: ["team a"] };
      return null;
    });
    hgetall.mockRejectedValue(new Error("redis down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const access = await resolveAccess("someone@example.com");
    expect(access.approved).toBe(true);
    expect(access.videoScope).toEqual([]);
  });

  it("denies an empty or missing email outright", async () => {
    stub();
    expect((await resolveAccess("")).approved).toBe(false);
    expect((await resolveAccess(null)).approved).toBe(false);
  });
});

describe("resolveAccess — viewers and groups", () => {
  it("approves an untagged viewer with the whole library", async () => {
    stub({ viewerMeta: { addedAt: "x", tags: [] } });
    const access = await resolveAccess("crew@example.com");
    expect(access.approved).toBe(true);
    expect(access.role).toBe("viewer");
    expect(access.capabilities).toEqual([]);
    expect(access.videoScope).toBe(null);
  });

  it("denies someone who is neither on the viewer list nor holds a role", async () => {
    stub();
    const access = await resolveAccess("stranger@example.com");
    expect(access.approved).toBe(false);
  });

  it("restricts a viewer to their group's allowlist", async () => {
    stub({
      viewerMeta: { addedAt: "x", tags: ["Team A"] },
      groups: { "team a": { restricted: true, videoIds: ["v1", "v2"] } },
    });
    const access = await resolveAccess("crew@example.com");
    expect(access.videoScope).toEqual(["v1", "v2"]);
  });

  it("leaves a viewer unrestricted when their group has no allowlist", async () => {
    stub({
      viewerMeta: { addedAt: "x", tags: ["Team A"] },
      groups: { "team a": { restricted: false, videoIds: ["v1"] } },
    });
    expect((await resolveAccess("crew@example.com")).videoScope).toBe(null);
  });
});

describe("resolveAccess — staff roles", () => {
  it("approves a manager who is not on the viewer list, unscoped", async () => {
    stub({ role: "manager" });
    const access = await resolveAccess("mate@example.com");
    expect(access.approved).toBe(true);
    expect(access.role).toBe("manager");
    expect(access.videoScope).toBe(null);
    expect(access.capabilities).toContain(CAP.VIDEOS);
    expect(access.capabilities).not.toContain(CAP.PEOPLE);
  });

  it("never scopes staff by group, even when tagged into a restricted one", async () => {
    stub({
      role: "manager",
      viewerMeta: { addedAt: "x", tags: ["Team A"] },
      groups: { "team a": { restricted: true, videoIds: ["v1"] } },
    });
    expect((await resolveAccess("mate@example.com")).videoScope).toBe(null);
  });

  it("treats a corrupt stored role as a plain viewer", async () => {
    stub({ role: "superadmin", viewerMeta: { addedAt: "x", tags: [] } });
    const access = await resolveAccess("odd@example.com");
    expect(access.role).toBe("viewer");
    expect(access.capabilities).toEqual([]);
  });
});
