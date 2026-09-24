// Deleting a video forgets its watermark setting too — on both delete paths.
// Before, the override row in k("watermark", "videos") outlived the video.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

const watermarkCalls = [];

vi.mock("../guard", () => ({ requireCapability: async () => ({ email: "admin@example.com" }) }));
vi.mock("../audit", () => ({ logAction: async () => {} }));
vi.mock("../bunny", () => ({
  deleteVideo: async () => {},
  listAllVideosWithStatus: async () => ({ videos: [], truncated: false, total: 0 }),
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
  setVideoWatermarkOverride: async (id, mode) => {
    watermarkCalls.push([id, mode]);
  },
}));
vi.mock("../groups", () => ({ getGroupMap: async () => ({}), pruneVideoFromGroups: async () => {} }));
vi.mock("../publicVideos", () => ({ getPublicMap: async () => ({}), prunePublicVideo: async () => {} }));
vi.mock("../videoMeta", async (importOriginal) => ({
  ...(await importOriginal()),
  getChaptersMap: async () => ({}),
  getNotesMap: async () => ({}),
  pruneVideoMeta: async () => {},
}));
vi.mock("../schedule", async (importOriginal) => ({
  ...(await importOriginal()),
  clearSchedule: async () => {},
  getScheduleMap: async () => ({}),
}));
vi.mock("../push", () => ({ maybeAnnounceReadyVideos: async () => {} }));
vi.mock("../transcriptCollect", () => ({ collectFinishedTranscripts: async () => ({ collected: [] }) }));

const route = (await import("../../pages/api/admin/videos")).default;

beforeEach(() => {
  watermarkCalls.length = 0;
});

describe("deleting a video clears its watermark setting", () => {
  it("on the single delete", async () => {
    const res = await callRoute(route, { method: "DELETE", query: { id: "vid-1" } });
    expect(res.statusCode).toBe(200);
    expect(watermarkCalls).toEqual([["vid-1", "default"]]);
  });

  it("on the bulk delete", async () => {
    const res = await callRoute(route, { method: "POST", body: { action: "bulk-delete", ids: ["vid-1", "vid-2"] } });
    expect(res.statusCode).toBe(200);
    expect(watermarkCalls.sort()).toEqual([["vid-1", "default"], ["vid-2", "default"]]);
  });
});
