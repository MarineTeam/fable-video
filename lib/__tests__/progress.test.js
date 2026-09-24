// lib/progress.js — the bounds on per-viewer playback progress.
import { describe, expect, it } from "vitest";
import { MAX_PROGRESS_ENTRIES, isProgressVideoId, progressToEvict } from "../progress";

describe("isProgressVideoId", () => {
  it("accepts a bunny video id", () => {
    expect(isProgressVideoId("0a1b2c3d-0000-4000-8000-000000000001")).toBe(true);
    expect(isProgressVideoId("vid-1")).toBe(true);
  });

  it("refuses anything else", () => {
    for (const bad of ["", "a".repeat(65), "has space", "x/../y", "ünïcode", null, 5, ["a"], { a: 1 }]) {
      expect(isProgressVideoId(bad), String(bad)).toBe(false);
    }
  });
});

describe("progressToEvict", () => {
  const at = (n) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();

  it("is 1,000 videos", () => {
    expect(MAX_PROGRESS_ENTRIES).toBe(1000);
  });

  it("drops nothing while there is room for one more", () => {
    expect(progressToEvict({ a: { at: at(1) }, b: { at: at(2) } }, 3)).toEqual([]);
  });

  it("drops the least recently watched to make room for one more", () => {
    const all = { new: { at: at(9) }, old: { at: at(1) }, mid: { at: at(5) } };
    expect(progressToEvict(all, 3)).toEqual(["old"]);
  });

  it("brings an over-full hash back under the cap in one go", () => {
    const all = { a: { at: at(1) }, b: { at: at(2) }, c: { at: at(3) }, d: { at: at(4) }, e: { at: at(5) } };
    expect(progressToEvict(all, 3)).toEqual(["a", "b", "c"]);
  });

  it("counts an entry with no readable time as the oldest", () => {
    const all = { good: { at: at(1) }, broken: { at: "not a date" }, missing: {} };
    expect(progressToEvict(all, 2).sort()).toEqual(["broken", "missing"]);
  });
});
