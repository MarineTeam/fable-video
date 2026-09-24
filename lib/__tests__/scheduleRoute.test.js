// POST /api/admin/videos { action: "set-schedule" } — what an admin may store
// as a video's schedule: the default window, a weekly repeat, and per-group
// windows. The pure rules are tested in repeatingSchedules/groupSchedules;
// this pins that the route applies them BEFORE anything is written.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute } from "./helpers/route";

const setSchedule = vi.fn(async (id, s) => ({ publishAt: null, expiresAt: null, ...s }));
let groupMap = { youth: { id: "youth", name: "Youth" } };

vi.mock("../guard", () => ({ requireCapability: async () => ({ email: "admin@example.com" }) }));
vi.mock("../audit", () => ({ logAction: async () => {} }));
vi.mock("../bunny", () => ({
  deleteVideo: async () => {},
  listAllVideos: async () => [],
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
vi.mock("../groups", () => ({ getGroupMap: async () => groupMap, pruneVideoFromGroups: async () => {} }));
vi.mock("../publicVideos", () => ({ getPublicMap: async () => ({}), prunePublicVideo: async () => {} }));
vi.mock("../videoMeta", async (importOriginal) => ({
  ...(await importOriginal()),
  getChaptersMap: async () => ({}),
  getNotesMap: async () => ({}),
  pruneVideoMeta: async () => {},
  setChapters: async () => {},
  setNotes: async () => {},
}));
vi.mock("../schedule", async (importOriginal) => ({
  ...(await importOriginal()),
  setSchedule: (...a) => setSchedule(...a),
  clearSchedule: async () => {},
  getScheduleMap: async () => ({}),
}));
vi.mock("../push", () => ({ maybeAnnounceReadyVideos: async () => {} }));
vi.mock("../transcriptCollect", () => ({ collectFinishedTranscripts: async () => {} }));

const route = (await import("../../pages/api/admin/videos")).default;

const save = (body) =>
  callRoute(route, { method: "POST", body: { action: "set-schedule", id: "vid-1", ...body } });

const sunday = { days: [0], start: "09:00", end: "13:00", timeZone: "Europe/London" };

beforeEach(() => {
  setSchedule.mockClear();
  groupMap = { youth: { id: "youth", name: "Youth" } };
});

describe("set-schedule", () => {
  it("stores a weekly repeat", async () => {
    const res = await save({ repeat: sunday });
    expect(res.statusCode).toBe(200);
    expect(setSchedule).toHaveBeenCalledWith("vid-1", expect.objectContaining({ repeat: sunday }));
  });

  it("refuses a repeat that would not do what was meant, and writes nothing", async () => {
    for (const repeat of [
      { ...sunday, days: [] },
      { ...sunday, end: "09:00" },
      { ...sunday, timeZone: "Nowhere/Special" },
    ]) {
      const res = await save({ repeat });
      expect(res.statusCode, JSON.stringify(repeat)).toBe(400);
    }
    expect(setSchedule).not.toHaveBeenCalled();
  });

  it("stores per-group windows for groups that exist, and refuses others", async () => {
    expect((await save({ groups: { youth: { publishAt: "2026-09-01T00:00:00.000Z" } } })).statusCode).toBe(200);
    expect((await save({ groups: { ghosts: { publishAt: "2026-09-01T00:00:00.000Z" } } })).statusCode).toBe(400);
    expect(setSchedule).toHaveBeenCalledTimes(1);
  });

  it("clears everything when nothing is sent", async () => {
    await save({ publishAt: null, expiresAt: null, groups: null, repeat: null });
    expect(setSchedule).toHaveBeenCalledWith("vid-1", {
      publishAt: null,
      expiresAt: null,
      groups: null,
      repeat: null,
    });
  });
});
