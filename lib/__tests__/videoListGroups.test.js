// lib/videoList.js fetchVideoLibrary — the viewer's groups reach the publish
// window check. This function feeds the homepage, /api/videos, search, the
// book index, My List and the podcast feed, so it is the one enforcement
// point most of the others share.
import { describe, expect, it, vi } from "vitest";

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

vi.mock("../bunny", () => ({
  listAllVideos: async () => [
    { guid: "early", title: "Early", status: 4, encodeProgress: 100 },
    { guid: "open", title: "Open", status: 4, encodeProgress: 100 },
  ],
  thumbnailUrl: () => null,
  thumbnailsEnabled: () => false,
  videoState: () => "ready",
}));
vi.mock("../store", () => ({
  getOrder: async () => [],
  applyOrder: (v) => v,
  getSettings: async () => ({ videoCount: 30 }),
}));
vi.mock("../schedule", async (importOriginal) => ({
  ...(await importOriginal()),
  getScheduleMap: async () => ({
    early: { publishAt: FUTURE, expiresAt: null, groups: { youth: { publishAt: PAST, expiresAt: null } } },
  }),
}));
vi.mock("../videoMeta", async (importOriginal) => ({
  ...(await importOriginal()),
  getNotesMap: async () => ({}),
}));

const { fetchVideoLibrary } = await import("../videoList");
const ids = (lib) => lib.videos.map((v) => v.id).sort();

describe("fetchVideoLibrary and per-group windows", () => {
  it("includes an early-access video for a member of that group", async () => {
    expect(ids(await fetchVideoLibrary(null, { groupIds: ["youth"] }))).toEqual(["early", "open"]);
  });

  it("leaves it out for everyone else — and for a caller that passes no groups", async () => {
    expect(ids(await fetchVideoLibrary(null, { groupIds: ["crew"] }))).toEqual(["open"]);
    expect(ids(await fetchVideoLibrary(null))).toEqual(["open"]);
  });
});
