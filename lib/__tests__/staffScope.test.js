// Group-scoped staff: what resolveAccess makes of a stored scope, and how a
// scope survives its groups being deleted.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mem } from "./helpers/memoryRedis";

vi.mock("../redis", async () => (await import("./helpers/memoryRedis")).redisModule);
vi.mock("../bunny", () => ({
  listAllVideos: async () => [
    { guid: "v1", collectionId: "" },
    { guid: "c1", collectionId: "sermons" },
  ],
}));

const { resolveAccess } = await import("../roles");
const { pruneGroupFromScopes, scopeForEmail, setScopeForEmail } = await import("../staffScope");

function world() {
  const groups = mem.hash("fablevideo:groups");
  groups.set("youth", { name: "Youth", restricted: true, videoIds: ["v1"], collectionIds: ["sermons"] });
  groups.set("open", { name: "Open", restricted: false, videoIds: ["v9"], collectionIds: [] });
  mem.hash("fablevideo:roles").set("staff", {
    id: "staff",
    name: "Staff",
    capabilities: ["videos.read", "videos.manage", "settings.manage", "audit.read"],
  });
  mem.hash("fablevideo:user:roles").set("s@x.com", ["staff"]);
}

beforeEach(() => {
  vi.restoreAllMocks();
  mem.reset();
  process.env.ADMIN_EMAILS = "owner@x.com";
  world();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("resolveAccess with a scope", () => {
  it("leaves an unscoped staff member as before: every capability, the whole library", async () => {
    const access = await resolveAccess("s@x.com");
    expect(access.staffScope).toBeNull();
    expect(access.videoScope).toBeNull();
    expect(access.capabilities).toContain("settings.manage");
  });

  it("limits the library to the scope's grants, collections expanded, and strips portal-wide capabilities", async () => {
    await setScopeForEmail("s@x.com", ["youth"]);
    const access = await resolveAccess("s@x.com");
    expect(access.staffScope).toEqual(["youth"]);
    expect(access.videoScope.sort()).toEqual(["c1", "v1"]);
    expect(access.capabilities).toEqual(["videos.manage", "videos.read"]);
    expect(access.staff).toBe(true);
  });

  it("gives an unrestricted group nothing — a label bounds nobody", async () => {
    await setScopeForEmail("s@x.com", ["open"]);
    const access = await resolveAccess("s@x.com");
    expect(access.videoScope).toEqual([]);
  });

  it("reads an emptied scope as NOTHING, never as the whole portal", async () => {
    await setScopeForEmail("s@x.com", []);
    const access = await resolveAccess("s@x.com");
    expect(access.staffScope).toEqual([]);
    expect(access.videoScope).toEqual([]);
    expect(access.capabilities).not.toContain("settings.manage");
  });

  it("ignores any scope stored for an owner", async () => {
    mem.hash("fablevideo:user:scope").set("owner@x.com", JSON.stringify(["youth"]));
    const access = await resolveAccess("owner@x.com");
    expect(access.staffScope).toBeNull();
    expect(access.videoScope).toBeNull();
  });

  it("denies, rather than unscopes, when the scope cannot be read", async () => {
    const real = mem.hash.bind(mem);
    vi.spyOn(mem, "hash").mockImplementation((key) => {
      if (key === "fablevideo:user:scope") throw new Error("redis down");
      return real(key);
    });
    const access = await resolveAccess("s@x.com");
    expect(access.approved).toBe(false);
    expect(access.capabilities).toEqual([]);
  });

  it("reads a present but unreadable scope as nothing", async () => {
    mem.hash("fablevideo:user:scope").set("s@x.com", "{not json");
    expect(await scopeForEmail("s@x.com")).toEqual([]);
  });
});

describe("pruneGroupFromScopes", () => {
  it("drops a deleted group and keeps an emptied scope as []", async () => {
    await setScopeForEmail("s@x.com", ["youth"]);
    await setScopeForEmail("t@x.com", ["open", "youth"]);
    await pruneGroupFromScopes("youth");
    expect(await scopeForEmail("s@x.com")).toEqual([]);
    expect(await scopeForEmail("t@x.com")).toEqual(["open"]);
  });

  it("lifting a scope removes the row", async () => {
    await setScopeForEmail("s@x.com", ["youth"]);
    await setScopeForEmail("s@x.com", null);
    expect(await scopeForEmail("s@x.com")).toBeNull();
  });
});
