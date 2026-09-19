// The AI-suggestion reader. What can go wrong here is quiet: a suggestion
// read at the wrong timestamp, a title dropped without a word, or — the one
// that matters most — a suggestion treated as a chapter. These pin the reading
// and the reporting; the "nothing is written" half is pinned in
// transcribeRoute.test.js, because that is where a write would have to happen.
import { describe, expect, it } from "vitest";
import { MAX_CHAPTERS, MAX_LABEL_LENGTH } from "../chapters";
import { sameChapters, suggestedChapters } from "../aiChapters";

describe("suggestedChapters: bunny's documented shape", () => {
  it("reads { title, start } in seconds", () => {
    const video = {
      chapters: [
        { title: "Worship", start: 0, end: 1110 },
        { title: "Sermon", start: 1455, end: 3600 },
      ],
    };
    expect(suggestedChapters(video).chapters).toEqual([
      { t: 0, label: "Worship" },
      { t: 1455, label: "Sermon" },
    ]);
  });

  it("falls back to moments when there are no chapters", () => {
    const video = { chapters: [], moments: [{ label: "Baptism", timestamp: 300 }] };
    expect(suggestedChapters(video).chapters).toEqual([{ t: 300, label: "Baptism" }]);
  });

  it("prefers chapters over moments when both exist", () => {
    const video = {
      chapters: [{ title: "Sermon", start: 60 }],
      moments: [{ label: "Baptism", timestamp: 300 }],
    };
    expect(suggestedChapters(video).chapters).toEqual([{ t: 60, label: "Sermon" }]);
  });

  it("returns nothing, and reports nothing, for a video with neither", () => {
    expect(suggestedChapters({})).toEqual({ chapters: [], ignored: [] });
    expect(suggestedChapters(null)).toEqual({ chapters: [], ignored: [] });
    expect(suggestedChapters({ chapters: "not an array" })).toEqual({
      chapters: [],
      ignored: [],
    });
  });
});

describe("suggestedChapters: what it refuses to guess", () => {
  it("skips an entry with no usable start time, and says so", () => {
    const { chapters, ignored } = suggestedChapters({
      chapters: [{ title: "Nowhere" }, { title: "Sermon", start: 60 }],
    });
    expect(chapters).toEqual([{ t: 60, label: "Sermon" }]);
    expect(ignored).toEqual([
      { index: 1, text: "Nowhere", reason: "no usable start time" },
    ]);
  });

  it("does not turn a missing or blank start into 0:00", () => {
    // Number("") is 0 and Number(null) is 0. Either would silently place a
    // chapter at the top of the video, which reads as a real suggestion.
    const { chapters, ignored } = suggestedChapters({
      chapters: [
        { title: "Blank", start: "" },
        { title: "Null", start: null },
        { title: "Junk", start: "later" },
      ],
    });
    expect(chapters).toEqual([]);
    expect(ignored).toHaveLength(3);
  });

  it("reads a numeric string start, which is still unambiguous", () => {
    expect(suggestedChapters({ chapters: [{ title: "Sermon", start: "90" }] }).chapters).toEqual(
      [{ t: 90, label: "Sermon" }]
    );
  });

  it("skips a negative start", () => {
    const { chapters, ignored } = suggestedChapters({ chapters: [{ title: "Early", start: -5 }] });
    expect(chapters).toEqual([]);
    expect(ignored[0].reason).toBe("no usable start time");
  });

  it("skips an untitled suggestion and names the second it was at", () => {
    const { chapters, ignored } = suggestedChapters({
      chapters: [{ title: "   ", start: 42 }],
    });
    expect(chapters).toEqual([]);
    expect(ignored).toEqual([{ index: 1, text: "", reason: "no title (at 42s)" }]);
  });

  it("floors a fractional start rather than storing it", () => {
    expect(suggestedChapters({ chapters: [{ title: "Sermon", start: 60.8 }] }).chapters).toEqual([
      { t: 60, label: "Sermon" },
    ]);
  });
});

describe("suggestedChapters: the same limits a typed list has", () => {
  it("strips control characters from a title", () => {
    const { chapters } = suggestedChapters({
      chapters: [{ title: "Ser\u0000mon​", start: 1 }],
    });
    expect(chapters[0].label).toBe("Ser mon");
  });

  it("truncates an over-long title instead of refusing it", () => {
    const { chapters } = suggestedChapters({
      chapters: [{ title: "x".repeat(MAX_LABEL_LENGTH + 50), start: 1 }],
    });
    expect(chapters[0].label).toHaveLength(MAX_LABEL_LENGTH);
  });

  it("stops at the chapter limit and reports the overflow", () => {
    const many = Array.from({ length: MAX_CHAPTERS + 3 }, (_, i) => ({
      title: `Part ${i}`,
      start: i * 10,
    }));
    const { chapters, ignored } = suggestedChapters({ chapters: many });
    expect(chapters).toHaveLength(MAX_CHAPTERS);
    expect(ignored).toHaveLength(3);
    expect(ignored[0].reason).toContain(`${MAX_CHAPTERS}`);
  });

  it("sorts by timestamp whatever order bunny returned", () => {
    const { chapters } = suggestedChapters({
      chapters: [
        { title: "Sermon", start: 1455 },
        { title: "Worship", start: 0 },
      ],
    });
    expect(chapters.map((c) => c.label)).toEqual(["Worship", "Sermon"]);
  });
});

describe("sameChapters", () => {
  const list = [
    { t: 0, label: "Worship" },
    { t: 60, label: "Sermon" },
  ];

  it("is true for identical lists", () => {
    expect(sameChapters(list, [...list.map((c) => ({ ...c }))])).toBe(true);
  });

  it("is false when a label or a time differs", () => {
    expect(sameChapters(list, [{ t: 0, label: "Worship" }, { t: 61, label: "Sermon" }])).toBe(
      false
    );
    expect(sameChapters(list, [{ t: 0, label: "worship" }, { t: 60, label: "Sermon" }])).toBe(
      false
    );
  });

  it("is false when one list is longer", () => {
    expect(sameChapters(list, list.slice(0, 1))).toBe(false);
  });

  it("treats two empty lists as the same, and non-lists as empty", () => {
    expect(sameChapters([], [])).toBe(true);
    expect(sameChapters(null, undefined)).toBe(true);
    expect(sameChapters(list, null)).toBe(false);
  });
});
