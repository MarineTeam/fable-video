import { describe, expect, it } from "vitest";
import { applyOrder } from "../order";

const video = (guid, dateUploaded) => ({ guid, dateUploaded });

describe("applyOrder", () => {
  it("sorts videos by the saved order", () => {
    const videos = [video("a"), video("b"), video("c")];
    const result = applyOrder(videos, ["c", "a", "b"]);
    expect(result.map((v) => v.guid)).toEqual(["c", "a", "b"]);
  });

  it("floats unplaced videos to the top, newest first", () => {
    const videos = [
      video("old-new", "2024-06-01T00:00:00Z"),
      video("placed", "2024-01-01T00:00:00Z"),
      video("newest", "2024-07-01T00:00:00Z"),
    ];
    const result = applyOrder(videos, ["placed"]);
    expect(result.map((v) => v.guid)).toEqual(["newest", "old-new", "placed"]);
  });

  it("ignores order entries for videos that no longer exist", () => {
    const videos = [video("a"), video("b")];
    const result = applyOrder(videos, ["deleted", "b", "a"]);
    expect(result.map((v) => v.guid)).toEqual(["b", "a"]);
  });

  it("handles an empty order and empty input", () => {
    expect(applyOrder([], ["a"])).toEqual([]);
    const videos = [
      video("a", "2024-01-02T00:00:00Z"),
      video("b", "2024-01-03T00:00:00Z"),
    ];
    expect(applyOrder(videos, []).map((v) => v.guid)).toEqual(["b", "a"]);
    expect(applyOrder(videos, null).map((v) => v.guid)).toEqual(["b", "a"]);
  });
});
