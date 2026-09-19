// pages/api/rating.js — the gate, and what the counters are told.
//
// Three properties are worth pinning because losing any of them is silent:
// rating cannot be used to probe outside your group scope; a repeated vote
// does not inflate the total; and a counter failure never costs the viewer
// their vote. The arithmetic itself lives in lib/__tests__/ratings.test.js.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

let access = null;
let stored = {};
let allowed = true;
let countsThrow = false;

const setRating = vi.fn(async (email, id, vote) => {
  stored[id] = vote;
});
const clearRating = vi.fn(async (email, id) => {
  delete stored[id];
});
const applyRatingCounts = vi.fn(async () => {
  if (countsThrow) throw new Error("redis down");
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
vi.mock("../ratelimit", () => ({ allowRequest: async () => allowed }));
vi.mock("../store", () => ({
  getRatings: async () => stored,
  setRating: (...a) => setRating(...a),
  clearRating: (...a) => clearRating(...a),
  applyRatingCounts: (...a) => applyRatingCounts(...a),
}));

const route = (await import("../../pages/api/rating")).default;

const approved = { email: "viewer@example.com", approved: true, staff: false, videoScope: null };

const post = (body) => callRoute(route, { method: "POST", body });

beforeEach(() => {
  access = { ...approved };
  stored = {};
  allowed = true;
  countsThrow = false;
  setRating.mockClear();
  clearRating.mockClear();
  applyRatingCounts.mockClear();
});

describe("who may rate", () => {
  it("refuses a caller with no access", async () => {
    access = null;
    const res = await post({ videoId: "vid-1", vote: "up" });
    expect(res.statusCode).toBe(401);
    expect(setRating).not.toHaveBeenCalled();
  });

  it("refuses a video outside the viewer's group scope, as 404", async () => {
    // 404 and not 403: a rating must not become a way to learn which ids
    // exist. Same answer the watch page gives.
    access = { ...approved, videoScope: ["vid-2"] };
    const res = await post({ videoId: "vid-1", vote: "up" });
    expect(res.statusCode).toBe(404);
    expect(setRating).not.toHaveBeenCalled();
  });

  it("allows a video inside the scope", async () => {
    access = { ...approved, videoScope: ["vid-1"] };
    expect((await post({ videoId: "vid-1", vote: "up" })).statusCode).toBe(200);
  });

  it("is rate limited", async () => {
    allowed = false;
    const res = await post({ videoId: "vid-1", vote: "up" });
    expect(res.statusCode).toBe(429);
    expect(setRating).not.toHaveBeenCalled();
  });

  it("takes no email parameter — the session decides whose rating this is", async () => {
    await post({ videoId: "vid-1", vote: "up", email: "someone@else.com" });
    expect(setRating.mock.calls[0][0]).toBe("viewer@example.com");
  });
});

describe("voting", () => {
  it("stores a first vote and tells the counters about it once", async () => {
    const res = await post({ videoId: "vid-1", vote: "up" });
    expect(res.body).toEqual({ ok: true, vote: "up" });
    expect(stored).toEqual({ "vid-1": "up" });
    expect(applyRatingCounts).toHaveBeenCalledWith({ "vid-1:up": 1 });
  });

  it("moves the count across when the vote changes", async () => {
    stored = { "vid-1": "up" };
    await post({ videoId: "vid-1", vote: "down" });
    expect(applyRatingCounts).toHaveBeenCalledWith({ "vid-1:up": -1, "vid-1:down": 1 });
  });

  it("does NOT double-count a repeated vote", async () => {
    stored = { "vid-1": "up" };
    const res = await post({ videoId: "vid-1", vote: "up" });
    expect(res.body).toEqual({ ok: true, vote: "up" });
    expect(setRating).not.toHaveBeenCalled();
    expect(applyRatingCounts).not.toHaveBeenCalled();
  });

  it("clears a vote on DELETE and takes the count back", async () => {
    stored = { "vid-1": "down" };
    const res = await callRoute(route, { method: "DELETE", query: { videoId: "vid-1" } });
    expect(res.body).toEqual({ ok: true, vote: null });
    expect(stored).toEqual({});
    expect(applyRatingCounts).toHaveBeenCalledWith({ "vid-1:down": -1 });
  });

  it("refuses a vote that is neither up nor down", async () => {
    const res = await post({ videoId: "vid-1", vote: "sideways" });
    expect(res.statusCode).toBe(400);
    expect(setRating).not.toHaveBeenCalled();
  });

  it("requires a video id", async () => {
    expect((await post({ vote: "up" })).statusCode).toBe(400);
  });
});

describe("reading your own rating", () => {
  it("returns it, and null when there is none", async () => {
    stored = { "vid-1": "up" };
    let res = await callRoute(route, { method: "GET", query: { videoId: "vid-1" } });
    expect(res.body).toEqual({ vote: "up" });
    res = await callRoute(route, { method: "GET", query: { videoId: "vid-2" } });
    expect(res.body).toEqual({ vote: null });
  });

  it("never returns anyone else's totals", async () => {
    stored = { "vid-1": "up" };
    const res = await callRoute(route, { method: "GET", query: { videoId: "vid-1" } });
    expect(Object.keys(res.body)).toEqual(["vote"]);
  });
});

describe("when the counters are unreachable", () => {
  it("the vote still stands — a total is decoration, a vote is not", async () => {
    countsThrow = true;
    const res = await post({ videoId: "vid-1", vote: "up" });
    expect(res.statusCode).toBe(200);
    expect(stored).toEqual({ "vid-1": "up" });
  });
});

describe("shape", () => {
  it("rejects an unsupported method", async () => {
    const res = await callRoute(route, { method: "PUT", query: { videoId: "vid-1" } });
    expect(res.statusCode).toBe(405);
  });
});
