// pages/api/admin/groups.js — the membership branch and its capability split.
//
// Editing membership is editing VIEWER records, so this route now reveals and
// writes people. The rule it must keep: groups.manage alone sees the record
// and a member COUNT, exactly as before; naming or changing members
// additionally needs viewers.read. Losing that turns a delegated groups.manage
// into a viewer-list reader, and the per-address result of a change into an
// oracle for "is this person approved?".
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";
import { CAP } from "../roles";

let caps = [CAP.GROUPS_MANAGE, CAP.VIEWERS_READ];
let viewers = [];
let groups = [];

const setViewerTags = vi.fn(async (email, tags) => {
  const viewer = viewers.find((v) => v.email === email);
  if (!viewer) return false;
  viewer.tags = tags;
  return true;
});

vi.mock("../guard", () => ({
  requireCapability: async (req, res, capability) => {
    if (!caps.includes(capability)) {
      res.status(403).json({ error: "You don't have permission to do that" });
      return null;
    }
    return { email: "admin@example.com", capabilities: caps };
  },
}));
vi.mock("../store", () => ({
  listViewers: async () => viewers.map((v) => ({ ...v, tags: [...v.tags] })),
  setViewerTags: (...a) => setViewerTags(...a),
}));
vi.mock("../audit", () => ({ logAction: async () => {} }));
// The real lib/groups.js is deliberately NOT mocked — its planning is what
// this route's answers are made of. Only the Redis underneath it is.
vi.mock("../redis", () => ({
  k: (...parts) => ["fablevideo", ...parts].join(":"),
  redis: () => ({
    hgetall: async () => Object.fromEntries(groups.map((g) => [g.id, g])),
    hget: async (key, field) => groups.find((g) => g.id === field) || null,
    hset: async () => 1,
    hdel: async () => 1,
  }),
}));

const route = (await import("../../pages/api/admin/groups")).default;

const patch = (body) => callRoute(route, { method: "PATCH", body });

beforeEach(() => {
  caps = [CAP.GROUPS_MANAGE, CAP.VIEWERS_READ];
  viewers = [
    { email: "in@x.com", tags: ["Team A"] },
    { email: "out@x.com", tags: ["Crew"] },
  ];
  groups = [];
  setViewerTags.mockClear();
});

describe("the capability split", () => {
  it("refuses a caller without groups.manage at all", async () => {
    caps = [CAP.VIEWERS_READ];
    expect((await patch({ name: "Team A", add: ["out@x.com"] })).statusCode).toBe(403);
    expect(setViewerTags).not.toHaveBeenCalled();
  });

  it("refuses a groups-only manager, who may not read the viewer list", async () => {
    caps = [CAP.GROUPS_MANAGE];
    const res = await patch({ name: "Team A", add: ["out@x.com"] });
    expect(res.statusCode).toBe(403);
    // Not even the "unknown address" answer, which would itself say whether
    // out@x.com is an approved viewer.
    expect(res.body.added).toBeUndefined();
    expect(setViewerTags).not.toHaveBeenCalled();
  });

  it("allows a caller holding both", async () => {
    expect((await patch({ name: "Team A", add: ["out@x.com"] })).statusCode).toBe(200);
  });
});

describe("changing membership", () => {
  it("adds and reports who changed", async () => {
    const res = await patch({ name: "Team A", add: ["out@x.com"] });
    expect(res.body.added).toEqual(["out@x.com"]);
    expect(res.body.members).toEqual(["in@x.com", "out@x.com"]);
    expect(setViewerTags).toHaveBeenCalledWith("out@x.com", ["Crew", "Team A"]);
  });

  it("removes and reports who changed", async () => {
    const res = await patch({ name: "Team A", remove: ["in@x.com"] });
    expect(res.body.removed).toEqual(["in@x.com"]);
    expect(res.body.members).toEqual([]);
  });

  it("reports the addresses that did nothing, rather than implying success", async () => {
    const res = await patch({
      name: "Team A",
      add: ["in@x.com", "ghost@x.com"],
    });
    expect(res.body.added).toEqual([]);
    expect(res.body.noop).toEqual(["in@x.com"]);
    expect(res.body.unknown).toEqual(["ghost@x.com"]);
  });

  it("does NOT report a failed write as a change", async () => {
    // The viewer left the list between the read and the write. Reporting
    // "added" would be a lie the admin then acts on.
    setViewerTags.mockImplementationOnce(async () => false);
    const res = await patch({ name: "Team A", add: ["out@x.com"] });
    expect(res.body.added).toEqual([]);
    expect(res.body.failed).toEqual(["out@x.com"]);
    expect(res.body.members).toEqual(["in@x.com"]);
  });

  it("requires a group name and at least one address", async () => {
    expect((await patch({ add: ["out@x.com"] })).statusCode).toBe(400);
    expect((await patch({ name: "Team A" })).statusCode).toBe(400);
  });

  it("caps the size of one change", async () => {
    const many = Array.from({ length: 201 }, (_, i) => `v${i}@x.com`);
    const res = await patch({ name: "Team A", add: many });
    expect(res.statusCode).toBe(400);
    expect(setViewerTags).not.toHaveBeenCalled();
  });

  it("ignores non-array add/remove rather than coercing them", async () => {
    const res = await patch({ name: "Team A", add: "out@x.com" });
    expect(res.statusCode).toBe(400);
    expect(setViewerTags).not.toHaveBeenCalled();
  });
});

describe("shape", () => {
  it("advertises PATCH", async () => {
    const res = await callRoute(route, { method: "POST", body: {} });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toContain("PATCH");
  });
});
