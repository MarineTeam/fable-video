// pages/api/rating.js — the gate, and what the counters are told.
//
// Two properties are worth pinning because losing either is silent: rating
// cannot be used to probe outside your group scope, and the vote goes to
// storage as ONE call (lib/store.js recordRating, a single Redis script), so
// there is no second write for the totals to drift on. The arithmetic is in
// ratings.test.js and, against a real Redis, ratingScripts.test.js.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

let access = null;
let stored = {};
let allowed = true;
let recordThrows = false;

// Stands in for the Redis script. The script's own arithmetic is proved
// against a real redis-server in ratingScripts.test.js; here only the route's
// side matters — what it asks for, and what it tells the viewer.
const recordRating = vi.fn(async (email, id, vote) => {
  if (recordThrows) throw new Error("redis down");
  if (vote) stored[id] = vote;
  else delete stored[id];
  return true;
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
  recordRating: (...a) => recordRating(...a),
}));

const route = (await import("../../pages/api/rating")).default;

const approved = { email: "viewer@example.com", approved: true, staff: false, videoScope: null };

const post = (body) => callRoute(route, { method: "POST", body });

beforeEach(() => {
  access = { ...approved };
  stored = {};
  allowed = true;
  recordThrows = false;
  recordRating.mockClear();
});

describe("who may rate", () => {
  it("refuses a caller with no access", async () => {
    access = null;
    const res = await post({ videoId: "vid-1", vote: "up" });
    expect(res.statusCode).toBe(401);
    expect(recordRating).not.toHaveBeenCalled();
  });

  it("refuses a video outside the viewer's group scope, as 404", async () => {
    // 404 and not 403: a rating must not become a way to learn which ids
    // exist. Same answer the watch page gives.
    access = { ...approved, videoScope: ["vid-2"] };
    const res = await post({ videoId: "vid-1", vote: "up" });
    expect(res.statusCode).toBe(404);
    expect(recordRating).not.toHaveBeenCalled();
  });

  it("allows a video inside the scope", async () => {
    access = { ...approved, videoScope: ["vid-1"] };
    expect((await post({ videoId: "vid-1", vote: "up" })).statusCode).toBe(200);
  });

  it("is rate limited", async () => {
    allowed = false;
    const res = await post({ videoId: "vid-1", vote: "up" });
    expect(res.statusCode).toBe(429);
    expect(recordRating).not.toHaveBeenCalled();
  });

  it("takes no email parameter — the session decides whose rating this is", async () => {
    await post({ videoId: "vid-1", vote: "up", email: "someone@else.com" });
    expect(recordRating.mock.calls[0][0]).toBe("viewer@example.com");
  });
});

describe("voting", () => {
  it("records a vote in one call, with the session's email", async () => {
    const res = await post({ videoId: "vid-1", vote: "up" });
    expect(res.body).toEqual({ ok: true, vote: "up" });
    expect(recordRating).toHaveBeenCalledTimes(1);
    expect(recordRating).toHaveBeenCalledWith("viewer@example.com", "vid-1", "up");
  });

  it("normalizes the vote before it reaches storage", async () => {
    await post({ videoId: "vid-1", vote: " DOWN " });
    expect(recordRating).toHaveBeenCalledWith("viewer@example.com", "vid-1", "down");
  });

  // The route no longer decides "is this a repeat?" itself — that read lives
  // inside the script now, which is what stops two racing clicks both
  // counting. So a repeat is passed through, and the script answers no-op.
  it("leaves the repeat decision to the script rather than reading first", async () => {
    stored = { "vid-1": "up" };
    const res = await post({ videoId: "vid-1", vote: "up" });
    expect(res.body).toEqual({ ok: true, vote: "up" });
    expect(recordRating).toHaveBeenCalledTimes(1);
  });

  it("clears a vote on DELETE by recording null", async () => {
    stored = { "vid-1": "down" };
    const res = await callRoute(route, { method: "DELETE", query: { videoId: "vid-1" } });
    expect(res.body).toEqual({ ok: true, vote: null });
    expect(recordRating).toHaveBeenCalledWith("viewer@example.com", "vid-1", null);
    expect(stored).toEqual({});
  });

  it("refuses a vote that is neither up nor down", async () => {
    const res = await post({ videoId: "vid-1", vote: "sideways" });
    expect(res.statusCode).toBe(400);
    expect(recordRating).not.toHaveBeenCalled();
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

describe("when storage fails", () => {
  // The vote and the counters are one write now, so there is no longer a
  // "vote stood but the counter failed" case to hide. A failure is reported,
  // and the button reverts to what is actually stored.
  it("reports the failure instead of claiming the vote stood", async () => {
    recordThrows = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ videoId: "vid-1", vote: "up" });
    spy.mockRestore();
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("redis down");
  });
});

describe("shape", () => {
  it("rejects an unsupported method", async () => {
    const res = await callRoute(route, { method: "PUT", query: { videoId: "vid-1" } });
    expect(res.statusCode).toBe(405);
  });
});
