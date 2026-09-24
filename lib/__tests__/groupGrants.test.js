// grantVideoToGroups against an in-memory groups hash: it touches exactly the
// chosen groups, keeps their other grants, and never recreates a group that
// was deleted or silently truncates one that filled up.
import { beforeEach, describe, expect, it, vi } from "vitest";

let groupRecords = {};
let failOn = null;

vi.mock("../redis", () => ({
  k: (...parts) => ["fablevideo", ...parts].join(":"),
  redis: () => ({
    hgetall: async () => groupRecords,
    hget: async (key, field) => {
      if (field === failOn) throw new Error("redis down");
      return groupRecords[field] || null;
    },
    hset: async (key, payload) => {
      Object.assign(groupRecords, payload);
      return 1;
    },
  }),
}));
vi.mock("../bunny", () => ({ listAllVideos: async () => [] }));

const { grantVideoToGroups, MAX_VIDEOS_PER_GROUP } = await import("../groups");

const group = (id, patch = {}) => ({
  id,
  name: id,
  restricted: true,
  videoIds: [],
  collectionIds: [],
  ...patch,
});

beforeEach(() => {
  failOn = null;
  groupRecords = {
    team: group("team", { videoIds: ["old"], collectionIds: ["c1"] }),
    youth: group("youth"),
    other: group("other"),
  };
});

describe("grantVideoToGroups", () => {
  it("adds the video to exactly the chosen groups, keeping their other grants", async () => {
    expect(await grantVideoToGroups("new", ["team", "youth"])).toEqual({
      granted: ["team", "youth"],
      failed: [],
    });
    expect(groupRecords.team.videoIds).toEqual(["old", "new"]);
    expect(groupRecords.team.collectionIds).toEqual(["c1"]);
    expect(groupRecords.team.restricted).toBe(true);
    expect(groupRecords.youth.videoIds).toEqual(["new"]);
    expect(groupRecords.other.videoIds).toEqual([]);
  });

  it("does not RECREATE a group deleted since the route checked", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await grantVideoToGroups("new", ["gone"]);
    spy.mockRestore();
    expect(result).toEqual({ granted: [], failed: ["gone"] });
    expect(groupRecords.gone).toBeUndefined();
  });

  it("reports a group that filled up since the route checked, instead of truncating it", async () => {
    const full = Array.from({ length: MAX_VIDEOS_PER_GROUP }, (_, i) => `v${i}`);
    groupRecords.youth = group("youth", { videoIds: full });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await grantVideoToGroups("new", ["youth", "other"]);
    spy.mockRestore();
    expect(result).toEqual({ granted: ["other"], failed: ["youth"] });
    expect(groupRecords.youth.videoIds).toEqual(full);
  });

  it("reports a group it could not read, and still grants the rest", async () => {
    failOn = "team";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await grantVideoToGroups("new", ["team", "youth"]);
    spy.mockRestore();
    expect(result).toEqual({ granted: ["youth"], failed: ["team"] });
  });
});
