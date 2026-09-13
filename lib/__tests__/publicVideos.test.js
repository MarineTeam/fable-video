// The public flag is the only switch in this app that makes something
// reachable without a session, so the tests here are about exactly one
// question: can `isPublicVideo` ever return true when it shouldn't?
//
// The fail-closed-on-error case is the important one and is the OPPOSITE of
// lib/schedule.js's polarity. If someone later "fixes" this to fail open for
// consistency, these tests are what stops it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hexists = vi.fn();
const hgetall = vi.fn();
const hset = vi.fn();
const hdel = vi.fn();

vi.mock("../redis", () => ({
  k: (...parts) => ["fablevideo", ...parts].join(":"),
  redis: () => ({ hexists, hgetall, hset, hdel }),
}));

const {
  getPublicMap,
  isPublicVideo,
  prunePublicVideo,
  publicVideoUrl,
  setPublicVideo,
  unsetPublicVideo,
} = await import("../publicVideos");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.APP_BASE_URL = "https://portal.example.com";
});

describe("isPublicVideo: default deny", () => {
  it("is true only when a row exists", async () => {
    hexists.mockResolvedValue(1);
    expect(await isPublicVideo("v1")).toBe(true);
    expect(hexists).toHaveBeenCalledWith("fablevideo:public", "v1");
  });

  it("is false when no row exists", async () => {
    hexists.mockResolvedValue(0);
    expect(await isPublicVideo("v1")).toBe(false);
  });

  it("is false for a blank id, without touching Redis", async () => {
    for (const id of ["", "   ", null, undefined]) {
      expect(await isPublicVideo(id)).toBe(false);
    }
    expect(hexists).not.toHaveBeenCalled();
  });

  // THE test. A Redis outage must not publish the library.
  it("is false when Redis throws — fails CLOSED", async () => {
    hexists.mockRejectedValue(new Error("redis is down"));
    expect(await isPublicVideo("v1")).toBe(false);
  });

  it("is false for every falsy answer Redis might give", async () => {
    for (const answer of [0, false, null, undefined]) {
      hexists.mockResolvedValue(answer);
      expect(await isPublicVideo("v1")).toBe(false);
    }
  });
});

describe("writes", () => {
  it("records who enabled it and when", async () => {
    await setPublicVideo("v1", "boss@example.com");
    const [key, payload] = hset.mock.calls[0];
    expect(key).toBe("fablevideo:public");
    expect(payload.v1.enabledBy).toBe("boss@example.com");
    expect(payload.v1.enabledAt).toEqual(expect.any(String));
  });

  it("turning it off deletes the row rather than storing false", async () => {
    await unsetPublicVideo("v1");
    expect(hdel).toHaveBeenCalledWith("fablevideo:public", "v1");
    expect(hset).not.toHaveBeenCalled();
  });

  // A recycled bunny.net id inheriting a public grant is the worst direction
  // for this flag to leak in.
  it("pruning a deleted video removes its public row", async () => {
    await prunePublicVideo("v1");
    expect(hdel).toHaveBeenCalledWith("fablevideo:public", "v1");
  });
});

describe("getPublicMap", () => {
  it("normalizes stored rows and tolerates junk values", async () => {
    hgetall.mockResolvedValue({
      v1: { enabledAt: "2026-09-01", enabledBy: "boss@example.com" },
      v2: "nonsense",
    });
    expect(await getPublicMap()).toEqual({
      v1: { enabledAt: "2026-09-01", enabledBy: "boss@example.com" },
      v2: { enabledAt: null, enabledBy: null },
    });
  });
});

describe("publicVideoUrl", () => {
  it("builds the one canonical address", () => {
    expect(publicVideoUrl("v1")).toBe("https://portal.example.com/watch/public/v1");
  });

  it("returns null when APP_BASE_URL is unset, rather than a broken half-link", () => {
    delete process.env.APP_BASE_URL;
    expect(publicVideoUrl("v1")).toBeNull();
  });

  it("tolerates a trailing slash on the base url", () => {
    process.env.APP_BASE_URL = "https://portal.example.com/";
    expect(publicVideoUrl("v1")).toBe("https://portal.example.com/watch/public/v1");
  });
});
