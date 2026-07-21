import { describe, expect, it } from "vitest";
import {
  isShareLive,
  rollupShareAnalyticsByVideo,
  sharePlaybackPatch,
  shareViewPatch,
} from "../shares";

describe("shareViewPatch", () => {
  it("stamps the first view and starts the count at 1", () => {
    const share = { viewCount: 0, firstViewedAt: null, lastViewedAt: null };
    const patch = shareViewPatch(share);
    expect(patch.viewCount).toBe(1);
    expect(patch.firstViewedAt).toBeTruthy();
    expect(patch.lastViewedAt).toBe(patch.firstViewedAt);
  });

  it("increments the count and moves lastViewedAt on later views, keeping firstViewedAt", () => {
    const share = {
      viewCount: 3,
      firstViewedAt: "2026-01-01T00:00:00.000Z",
      lastViewedAt: "2026-01-02T00:00:00.000Z",
    };
    const patch = shareViewPatch(share);
    expect(patch.viewCount).toBe(4);
    expect(patch.firstViewedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(patch.lastViewedAt).not.toBe("2026-01-02T00:00:00.000Z");
  });

  it("falls back to the legacy viewedAt field for firstViewedAt", () => {
    const share = { viewCount: 1, firstViewedAt: null, viewedAt: "2026-01-01T00:00:00.000Z" };
    const patch = shareViewPatch(share);
    expect(patch.firstViewedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("sharePlaybackPatch", () => {
  it("increments playCount on a play event", () => {
    const share = { playCount: 2, furthestPercent: 10 };
    const patch = sharePlaybackPatch(share, { event: "play" });
    expect(patch.playCount).toBe(3);
    expect(patch.furthestPercent).toBeUndefined();
  });

  it("raises furthestPercent to a high-water mark, never lowering it", () => {
    const share = { furthestPercent: 40 };
    expect(sharePlaybackPatch(share, { event: "progress", percent: 55 }).furthestPercent).toBe(55);
    expect(sharePlaybackPatch(share, { event: "progress", percent: 20 }).furthestPercent).toBe(40);
  });

  it("clamps percent to 0-100 and rounds it", () => {
    const share = { furthestPercent: 0 };
    expect(sharePlaybackPatch(share, { event: "progress", percent: 123 }).furthestPercent).toBe(100);
    expect(sharePlaybackPatch(share, { event: "progress", percent: -5 }).furthestPercent).toBe(0);
    expect(sharePlaybackPatch(share, { event: "progress", percent: 33.6 }).furthestPercent).toBe(34);
  });

  it("marks completion and forces furthestPercent to 100 on ended", () => {
    const share = { furthestPercent: 70 };
    const patch = sharePlaybackPatch(share, { event: "ended" });
    expect(patch.completedAt).toBeTruthy();
    expect(patch.furthestPercent).toBe(100);
  });

  it("ignores a non-numeric or missing percent", () => {
    const share = { furthestPercent: 10 };
    expect(sharePlaybackPatch(share, { event: "progress" })).toEqual({});
    expect(sharePlaybackPatch(share, { event: "progress", percent: "x" })).toEqual({});
  });
});

describe("isShareLive", () => {
  it("is false for a missing share", () => {
    expect(isShareLive(null)).toBe(false);
    expect(isShareLive(undefined)).toBe(false);
  });

  it("is true when expiresAt is in the future", () => {
    const share = { expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    expect(isShareLive(share)).toBe(true);
  });

  it("is false once expiresAt has passed, even though the record still exists (grace window)", () => {
    const share = { expiresAt: new Date(Date.now() - 3600_000).toISOString() };
    expect(isShareLive(share)).toBe(false);
  });

  it("is false for a soft-revoked share even though expiresAt is still in the future", () => {
    const share = {
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      revoked: true,
    };
    expect(isShareLive(share)).toBe(false);
  });
});

describe("rollupShareAnalyticsByVideo", () => {
  it("groups by video and counts unique recipients", () => {
    const shares = [
      { videoId: "v1", videoTitle: "One", email: "a@x.com", viewCount: 2, playCount: 1, furthestPercent: 50, completedAt: null },
      { videoId: "v1", videoTitle: "One", email: "b@x.com", viewCount: 1, playCount: 0, furthestPercent: 0, completedAt: null },
      { videoId: "v1", videoTitle: "One", email: "a@x.com", viewCount: 3, playCount: 2, furthestPercent: 100, completedAt: "2026-01-01T00:00:00Z" },
      { videoId: "v2", videoTitle: "Two", email: "c@x.com", viewCount: 1, playCount: 1, furthestPercent: 20, completedAt: null },
    ];
    const rollup = rollupShareAnalyticsByVideo(shares);

    const v1 = rollup.find((r) => r.videoId === "v1");
    expect(v1.shares).toBe(3);
    expect(v1.uniqueRecipients).toBe(2);
    expect(v1.views).toBe(6);
    expect(v1.started).toBe(2);
    expect(v1.completed).toBe(1);
    expect(v1.completionRate).toBe(33);
    expect(v1.avgProgress).toBe(50);

    const v2 = rollup.find((r) => r.videoId === "v2");
    expect(v2.shares).toBe(1);
    expect(v2.uniqueRecipients).toBe(1);
  });

  it("sorts videos by share count, most-shared first", () => {
    const shares = [
      { videoId: "few", videoTitle: "Few", email: "a@x.com", viewCount: 0, playCount: 0, furthestPercent: 0, completedAt: null },
      { videoId: "many", videoTitle: "Many", email: "a@x.com", viewCount: 0, playCount: 0, furthestPercent: 0, completedAt: null },
      { videoId: "many", videoTitle: "Many", email: "b@x.com", viewCount: 0, playCount: 0, furthestPercent: 0, completedAt: null },
    ];
    const rollup = rollupShareAnalyticsByVideo(shares);
    expect(rollup.map((r) => r.videoId)).toEqual(["many", "few"]);
  });

  it("returns an empty array for no shares", () => {
    expect(rollupShareAnalyticsByVideo([])).toEqual([]);
  });
});
