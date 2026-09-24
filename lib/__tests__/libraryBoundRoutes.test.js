// The admin Videos tab and Analytics say when the library is larger than one
// whole-library read (lib/bunny.js MAX_LIBRARY_PAGES, 1,000 videos), rather
// than presenting the newest videos as the whole library.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

let library = { videos: [], truncated: false, total: 0 };

vi.mock("../guard", () => ({ requireCapability: async () => ({ email: "admin@example.com" }) }));
vi.mock("../audit", () => ({ logAction: async () => {} }));
vi.mock("../bunny", () => ({
  deleteVideo: async () => {},
  listAllVideosWithStatus: async () => library,
  getStatistics: async () => ({}),
  thumbnailsEnabled: () => false,
  thumbnailUrl: () => null,
  updateVideo: async () => {},
  videoState: () => "ready",
}));
vi.mock("../store", () => ({
  clearVideoRatingCounts: async () => {},
  getOrder: async () => [],
  getRatingCounts: async () => ({}),
  getVideoWatermarkOverrides: async () => ({}),
  pruneFromOrder: async () => {},
  setVideoWatermarkOverride: async () => {},
}));
vi.mock("../shares", () => ({
  listShares: async () => [],
  rollupShareAnalyticsByVideo: () => [],
}));
vi.mock("../groups", () => ({ getGroupMap: async () => ({}), pruneVideoFromGroups: async () => {} }));
vi.mock("../publicVideos", () => ({ getPublicMap: async () => ({}), prunePublicVideo: async () => {} }));
vi.mock("../videoMeta", async (importOriginal) => ({
  ...(await importOriginal()),
  getChaptersMap: async () => ({}),
  getNotesMap: async () => ({}),
}));
vi.mock("../schedule", async (importOriginal) => ({
  ...(await importOriginal()),
  getScheduleMap: async () => ({}),
}));
vi.mock("../push", () => ({ maybeAnnounceReadyVideos: async () => {} }));
vi.mock("../transcriptCollect", () => ({ collectFinishedTranscripts: async () => ({ collected: [] }) }));

const videosRoute = (await import("../../pages/api/admin/videos")).default;
const analyticsRoute = (await import("../../pages/api/admin/analytics")).default;

const makeVideos = (n) =>
  Array.from({ length: n }, (_, i) => ({ guid: `v${i + 1}`, title: `Talk ${i + 1}`, views: 1 }));

beforeEach(() => {
  library = { videos: [], truncated: false, total: 0 };
});

describe("/api/admin/videos", () => {
  it("lists every video it read, and says nothing was cut", async () => {
    library = { videos: makeVideos(800), truncated: false, total: 800 };
    const res = await callRoute(videosRoute, { method: "GET" });
    expect(res.statusCode).toBe(200);
    expect(res.body.videos).toHaveLength(800);
    expect(res.body.truncated).toBe(false);
  });

  it("says so when the library is larger than one read", async () => {
    library = { videos: makeVideos(1000), truncated: true, total: 1300 };
    const res = await callRoute(videosRoute, { method: "GET" });
    expect(res.body.truncated).toBe(true);
  });
});

describe("/api/admin/analytics", () => {
  it("counts every video it read", async () => {
    library = { videos: makeVideos(800), truncated: false, total: 800 };
    const res = await callRoute(analyticsRoute, { method: "GET" });
    expect(res.body.videoCount).toBe(800);
    expect(res.body.totalViews).toBe(800);
    expect(res.body.truncated).toBe(false);
  });

  it("reports the real total, and how many the totals cover, past the bound", async () => {
    library = { videos: makeVideos(1000), truncated: true, total: 1300 };
    const res = await callRoute(analyticsRoute, { method: "GET" });
    expect(res.body.videoCount).toBe(1300);
    expect(res.body.covered).toBe(1000);
    expect(res.body.truncated).toBe(true);
  });
});
