// pages/api/passages.js — the book index. A count is information
// ("Philippians (3)" says three videos exist), so the only thing that matters
// beyond the arithmetic is that it is built over the viewer's SCOPED library
// and nothing wider.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

let access = null;
let allowed = true;
let libraryVideos = [];
let libraryThrows = false;
let scopeSeen;
let capSeen;

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
vi.mock("../videoList", () => ({
  fetchVideoLibrary: async (scope, options) => {
    if (libraryThrows) throw new Error("bunny down at vid-secret");
    scopeSeen = scope;
    capSeen = options?.cap;
    return { videos: libraryVideos, thumbnails: true };
  },
}));

const route = (await import("../../pages/api/passages")).default;
const get = () => callRoute(route, { method: "GET" });

beforeEach(() => {
  access = { email: "viewer@example.com", approved: true, staff: false, videoScope: ["a"] };
  allowed = true;
  libraryThrows = false;
  scopeSeen = undefined;
  capSeen = undefined;
  libraryVideos = [
    { id: "a", title: "Humility", notes: "Phil 2:1-11" },
    { id: "b", title: "Joy — Php 4:4", notes: null },
  ];
});

describe("book index", () => {
  it("counts books over the library the viewer may see", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ books: [{ book: "Philippians", count: 2 }] });
  });

  it("builds from the viewer's SCOPE, uncapped — the same pipeline as search", async () => {
    await get();
    expect(scopeSeen).toEqual(["a"]);
    expect(capSeen).toBe(false);
  });

  it("refuses an anonymous caller before reading anything", async () => {
    access = null;
    expect((await get()).statusCode).toBe(401);
    expect(scopeSeen).toBeUndefined();
  });

  it("is rate limited", async () => {
    allowed = false;
    expect((await get()).statusCode).toBe(429);
  });

  it("502s without echoing the error", async () => {
    libraryThrows = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get();
    spy.mockRestore();
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("vid-secret");
  });

  it("is GET only", async () => {
    const res = await callRoute(route, { method: "POST" });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET");
  });
});
