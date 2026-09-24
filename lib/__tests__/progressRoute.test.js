// POST /api/progress — what a viewer's player may write. Before these checks
// the route took any string up to 100 characters as a video id, with no rate
// limit, so a signed-in viewer could grow their own progress hash without
// bound. The hash's own cap is proved on a real Redis in progressStore.redis.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

let access;
let allowed = true;
const saved = [];

vi.mock("../guard", () => ({ requireAccess: async () => access }));
vi.mock("../ratelimit", () => ({ allowRequest: async () => allowed }));
vi.mock("../store", () => ({
  getProgress: async () => ({}),
  saveProgress: async (email, videoId, entry) => {
    saved.push([email, videoId, entry]);
  },
}));
vi.mock("../bunny", () => ({ listAllVideos: async () => [], thumbnailUrl: () => null }));
vi.mock("../schedule", () => ({ getScheduleMap: async () => ({}), isLiveFor: () => true }));

const route = (await import("../../pages/api/progress")).default;
const post = (body) => callRoute(route, { method: "POST", body });

beforeEach(() => {
  access = { email: "jane@example.com", staff: false, videoScope: null, groupIds: [] };
  allowed = true;
  saved.length = 0;
});

describe("POST /api/progress", () => {
  it("saves a position for a real-looking video id", async () => {
    const res = await post({ videoId: "0a1b2c3d-0000-4000-8000-000000000001", t: 30.7, d: 600 });
    expect(res.statusCode).toBe(200);
    expect(saved).toHaveLength(1);
    expect(saved[0][1]).toBe("0a1b2c3d-0000-4000-8000-000000000001");
    expect(saved[0][2]).toMatchObject({ t: 30, d: 600 });
  });

  it("is rate limited, and saves nothing when it is", async () => {
    allowed = false;
    expect((await post({ videoId: "vid-1", t: 1, d: 10 })).statusCode).toBe(429);
    expect(saved).toEqual([]);
  });

  it("refuses an id that is not a video id", async () => {
    for (const videoId of ["has space", "x/../y", "a".repeat(65), ["vid-1"], 5]) {
      expect((await post({ videoId, t: 1, d: 10 })).statusCode, String(videoId)).toBe(400);
    }
    expect(saved).toEqual([]);
  });

  it("refuses a video outside the viewer's groups, as 404", async () => {
    access = { ...access, videoScope: ["allowed-1"] };
    expect((await post({ videoId: "other-2", t: 1, d: 10 })).statusCode).toBe(404);
    expect((await post({ videoId: "allowed-1", t: 1, d: 10 })).statusCode).toBe(200);
    expect(saved.map((s) => s[1])).toEqual(["allowed-1"]);
  });

  it("still refuses a bad position", async () => {
    expect((await post({ videoId: "vid-1", t: -1, d: 10 })).statusCode).toBe(400);
    expect((await post({ videoId: "vid-1", t: 1, d: 0 })).statusCode).toBe(400);
  });
});
