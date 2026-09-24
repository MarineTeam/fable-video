// pages/api/admin/upload.js — choosing groups at upload time, and cleaning
// them up when an upload is cancelled.
//
// Under custom roles "may upload" and "may manage groups" are SEPARATE
// capabilities, so the first property below is a real boundary here: an
// uploader without groups.manage must not gain it by ticking a box.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

let access = null;
let groupMap = {};
let groupsThrow = false;
let created = [];
let audit = [];
let pruned = [];
let grant = null;

vi.mock("../guard", () => ({ requireCapability: async () => access }));
vi.mock("../ratelimit", () => ({ allowRequest: async () => true }));
vi.mock("../bunny", () => ({
  createVideo: async (title) => {
    created.push(title);
    return { guid: "vid-new" };
  },
  deleteVideo: async () => {},
  signTusUpload: () => ({ signature: "sig" }),
}));
vi.mock("../store", () => ({ pruneFromOrder: async () => {} }));
vi.mock("../audit", () => ({ logAction: async (...a) => audit.push(a) }));
vi.mock("../groups", () => ({
  MAX_VIDEOS_PER_GROUP: 500,
  getGroupMap: async () => {
    if (groupsThrow) throw new Error("redis down");
    return groupMap;
  },
  grantVideoToGroups: (...a) => grant(...a),
  pruneVideoFromGroups: async (id) => pruned.push(id),
}));

const route = (await import("../../pages/api/admin/upload")).default;
const { CAP } = await import("../capabilities");

const post = (body) => callRoute(route, { method: "POST", body });

beforeEach(() => {
  access = { email: "uploader@example.com", capabilities: [CAP.VIDEOS_UPLOAD, CAP.GROUPS_MANAGE] };
  groupMap = { team: { id: "team", name: "Team", videoIds: [] } };
  groupsThrow = false;
  created = [];
  audit = [];
  pruned = [];
  grant = vi.fn(async (_id, ids) => ({ granted: ids, failed: [] }));
});

describe("upload with no groups", () => {
  it("is the request it always was — no group read, no grant", async () => {
    groupsThrow = true; // would 502 if the route touched groups at all
    const res = await post({ title: "Sunday" });
    expect(res.statusCode).toBe(201);
    expect(created).toEqual(["Sunday"]);
    expect(grant).not.toHaveBeenCalled();
  });

  it("works for an uploader who does not hold groups.manage", async () => {
    access = { email: "u@example.com", capabilities: [CAP.VIDEOS_UPLOAD] };
    expect((await post({ title: "Sunday" })).statusCode).toBe(201);
  });
});

describe("upload with groups", () => {
  it("grants the new video to the chosen groups and records it", async () => {
    const res = await post({ title: "Sunday", groupIds: ["team"] });
    expect(res.statusCode).toBe(201);
    expect(grant).toHaveBeenCalledWith("vid-new", ["team"]);
    expect(res.body.groups).toEqual({ granted: ["team"], failed: [] });
    expect(audit.some(([, action]) => action === "group.grant")).toBe(true);
  });

  it("refuses an uploader WITHOUT groups.manage, before creating the video", async () => {
    access = { email: "u@example.com", capabilities: [CAP.VIDEOS_UPLOAD] };
    const res = await post({ title: "Sunday", groupIds: ["team"] });
    expect(res.statusCode).toBe(403);
    expect(created).toEqual([]);
  });

  it("refuses an unknown group before creating the video", async () => {
    const res = await post({ title: "Sunday", groupIds: ["team", "gone"] });
    expect(res.statusCode).toBe(400);
    expect(created).toEqual([]);
  });

  it("502s without creating the video when groups cannot be read", async () => {
    groupsThrow = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ title: "Sunday", groupIds: ["team"] });
    spy.mockRestore();
    expect(res.statusCode).toBe(502);
    expect(created).toEqual([]);
  });

  it("still starts the upload when a grant fails afterwards, and says which", async () => {
    grant = vi.fn(async () => ({ granted: [], failed: ["team"] }));
    const res = await post({ title: "Sunday", groupIds: ["team"] });
    expect(res.statusCode).toBe(201);
    expect(res.body.tus).toEqual({ signature: "sig" });
    expect(res.body.groups.failed).toEqual(["team"]);
    expect(audit.some(([, action]) => action === "group.grant")).toBe(false);
  });
});

describe("cancelling an upload", () => {
  it("clears the half-made video from any group it was granted to", async () => {
    const res = await callRoute(route, { method: "DELETE", query: { id: "vid-new" } });
    expect(res.statusCode).toBe(200);
    expect(pruned).toEqual(["vid-new"]);
  });
});
