// pages/api/mylist.js — the gate and the write rules, not the list logic
// (that is lib/__tests__/mylist.test.js).
//
// Two properties are worth pinning here because losing either is silent:
// saving cannot be used to reach outside your group scope, and the list you
// read back is filtered by the same library call the homepage uses, so a
// saved video that later leaves your scope disappears from it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

let access = null;
let stored = {};
let libraryVideos = [];
let allowed = true;

const saveToMyList = vi.fn(async (email, id) => {
  stored[id] = Date.now();
});
const removeFromMyList = vi.fn(async (email, id) => {
  delete stored[id];
});

vi.mock("../guard", () => ({
  requireAccess: async (req, res) => {
    if (!access) {
      res.status(401).json({ error: "Sign in" });
      return null;
    }
    return access;
  },
}));
// The publish window, controllable per test. Redis is the seam — the REAL
// lib/schedule.js (getSchedule, isLiveFor, viewerMayActOn) runs on top of it,
// so the rule under test is the one the route actually uses.
let schedule = null;
let scheduleThrows = false;
vi.mock("../redis", () => ({
  k: (...parts) => ["fablevideo", ...parts].join(":"),
  redis: () => ({
    hget: async (key) => {
      if (key !== "fablevideo:schedule") return null;
      if (scheduleThrows) throw new Error("redis down");
      return schedule;
    },
  }),
}));
vi.mock("../ratelimit", () => ({ allowRequest: async () => allowed }));
vi.mock("../store", () => ({
  getMyList: async () => stored,
  saveToMyList: (...a) => saveToMyList(...a),
  removeFromMyList: (...a) => removeFromMyList(...a),
}));
vi.mock("../videoList", () => ({
  fetchVideoLibrary: async () => ({ videos: libraryVideos, thumbnails: true }),
}));

const route = (await import("../../pages/api/mylist")).default;

const approved = { email: "viewer@example.com", approved: true, staff: false, videoScope: null };

beforeEach(() => {
  access = { ...approved };
  stored = {};
  libraryVideos = [{ id: "vid-1", title: "One" }, { id: "vid-2", title: "Two" }];
  allowed = true;
  saveToMyList.mockClear();
  schedule = null;
  scheduleThrows = false;
  removeFromMyList.mockClear();
});

describe("reading the list", () => {
  it("returns saved videos newest-saved first, not library order", async () => {
    stored = { "vid-1": 1000, "vid-2": 5000 };
    const res = await callRoute(route, { method: "GET" });
    expect(res.statusCode).toBe(200);
    expect(res.body.videos.map((v) => v.id)).toEqual(["vid-2", "vid-1"]);
  });

  // The whole reason the route reads through fetchVideoLibrary rather than
  // returning bare ids: that call already applies group scope, the publish
  // window and readiness, so saving something can never outlive the right to
  // see it.
  it("drops a saved video that is no longer in the viewer's library", async () => {
    stored = { "vid-1": 1000, "gone-from-library": 2000 };
    const res = await callRoute(route, { method: "GET" });
    expect(res.body.videos.map((v) => v.id)).toEqual(["vid-1"]);
  });

  it("refuses an anonymous caller", async () => {
    access = null;
    expect((await callRoute(route, { method: "GET" })).statusCode).toBe(401);
  });
});

describe("saving", () => {
  it("saves a video the viewer can see", async () => {
    const res = await callRoute(route, { method: "POST", body: { videoId: "vid-1" } });
    expect(res.statusCode).toBe(200);
    expect(res.body.saved).toBe(true);
    expect(saveToMyList).toHaveBeenCalledWith("viewer@example.com", "vid-1");
  });

  // Saving must not be a way to confirm an id exists outside your scope.
  it("404s a video outside the viewer's scope and writes nothing", async () => {
    access = { ...approved, videoScope: ["vid-2"] };
    const res = await callRoute(route, { method: "POST", body: { videoId: "vid-1" } });
    expect(res.statusCode).toBe(404);
    expect(saveToMyList).not.toHaveBeenCalled();
  });

  it("400s a missing or wrong-typed videoId rather than coercing it", async () => {
    expect((await callRoute(route, { method: "POST", body: {} })).statusCode).toBe(400);
    const arr = await callRoute(route, { method: "POST", body: { videoId: ["a", "b"] } });
    expect(arr.statusCode).toBe(400);
    expect(saveToMyList).not.toHaveBeenCalled();
  });

  it("409s a full list with a message naming the cap", async () => {
    for (let i = 0; i < 200; i += 1) stored[`old-${i}`] = i;
    libraryVideos = [{ id: "vid-1" }];
    const res = await callRoute(route, { method: "POST", body: { videoId: "vid-1" } });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain("200");
    expect(saveToMyList).not.toHaveBeenCalled();
  });

  // Re-saving something already present does not grow the list, so a full
  // list must not refuse it — that would be an error on a no-op.
  it("allows re-saving an entry already in a full list", async () => {
    for (let i = 0; i < 200; i += 1) stored[`old-${i}`] = i;
    const res = await callRoute(route, { method: "POST", body: { videoId: "old-0" } });
    expect(res.statusCode).toBe(200);
  });

  it("429s when the viewer write budget is spent", async () => {
    allowed = false;
    const res = await callRoute(route, { method: "POST", body: { videoId: "vid-1" } });
    expect(res.statusCode).toBe(429);
    expect(saveToMyList).not.toHaveBeenCalled();
  });
});

describe("unsaving", () => {
  it("removes an entry", async () => {
    stored = { "vid-1": 1000 };
    const res = await callRoute(route, { method: "DELETE", query: { videoId: "vid-1" } });
    expect(res.statusCode).toBe(200);
    expect(res.body.saved).toBe(false);
    expect(removeFromMyList).toHaveBeenCalledWith("viewer@example.com", "vid-1");
  });

  it("is still scope-gated", async () => {
    access = { ...approved, videoScope: ["vid-2"] };
    const res = await callRoute(route, { method: "DELETE", query: { videoId: "vid-1" } });
    expect(res.statusCode).toBe(404);
    expect(removeFromMyList).not.toHaveBeenCalled();
  });
});

describe("shape", () => {
  it("405s an unsupported verb and names what is allowed", async () => {
    const res = await callRoute(route, { method: "PATCH" });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET, POST, DELETE");
  });

  // The route takes no email parameter at all, which is a stronger guarantee
  // than validating one: there is no input that could name another person.
  it("ignores any email in the request and uses the session's", async () => {
    await callRoute(route, {
      method: "POST",
      body: { videoId: "vid-1", email: "someone.else@example.com" },
      query: { email: "someone.else@example.com" },
    });
    expect(saveToMyList).toHaveBeenCalledWith("viewer@example.com", "vid-1");
  });
});

describe("the publish window", () => {
  const future = () => new Date(Date.now() + 86_400_000).toISOString();
  const past = () => new Date(Date.now() - 86_400_000).toISOString();

  it("refuses to ACT on a video that is not published yet, as 404", async () => {
    schedule = { publishAt: future(), expiresAt: null };
    const res = await callRoute(route, { method: "POST", body: { videoId: "vid-1" } });
    expect(res.statusCode).toBe(404);
    expect(saveToMyList).not.toHaveBeenCalled();
  });

  it("refuses a video whose window has closed", async () => {
    schedule = { publishAt: null, expiresAt: past() };
    expect((await callRoute(route, { method: "POST", body: { videoId: "vid-1" } })).statusCode).toBe(404);
  });

  it("follows a per-group window for a member", async () => {
    schedule = { publishAt: future(), expiresAt: null, groups: { youth: { publishAt: past(), expiresAt: null } } };
    access = { ...access, groupIds: ["youth"] };
    expect((await callRoute(route, { method: "POST", body: { videoId: "vid-1" } })).statusCode).toBe(200);
  });

  it("lets staff act outside the window, as they can watch there", async () => {
    schedule = { publishAt: future(), expiresAt: null };
    access = { ...access, staff: true };
    expect((await callRoute(route, { method: "POST", body: { videoId: "vid-1" } })).statusCode).toBe(200);
  });

  it("treats an unreadable schedule as no constraint, like the watch page", async () => {
    scheduleThrows = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callRoute(route, { method: "POST", body: { videoId: "vid-1" } });
    spy.mockRestore();
    expect(res.statusCode).toBe(200);
  });

  it("still lets the viewer UNDO outside the window", async () => {
    schedule = { publishAt: null, expiresAt: past() };
    expect((await callRoute(route, { method: "DELETE", query: { videoId: "vid-1" } })).statusCode).toBe(200);
  });
});
