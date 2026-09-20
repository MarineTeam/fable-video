// Library-wide search — the pure half.
//
// The thing this feature exists to fix is a REACH bug, not a matching bug: a
// video past the homepage cap could not be found by searching for it. So the
// tests that matter are about what gets included, what order it comes back in,
// and what happens when a query matches more than anyone wants to receive.
import { describe, expect, it } from "vitest";
import {
  MAX_RESULTS,
  MIN_TRANSCRIPT_QUERY,
  normalizeSpoken,
  searchLibrary,
  spokenMatches,
  videoMatches,
} from "../search";

const sermon = { id: "vid-1", title: "Sunday service", notes: "Philippians 4" };
const other = { id: "vid-2", title: "Harbour tour", notes: "" };

describe("normalizeSpoken", () => {
  it("deletes apostrophes so possessives match", () => {
    // Spacing them instead would split "Christ's" into "christ s", which
    // matches neither "christs" nor "christ".
    expect(normalizeSpoken("Christ's")).toBe("christs");
    expect(normalizeSpoken("Christ’s")).toBe("christs");
  });

  it("turns other punctuation into a space, not nothing", () => {
    // "end. Start" must not become one word.
    expect(normalizeSpoken("end. Start")).toBe("end start");
  });

  it("collapses whitespace and lowercases", () => {
    expect(normalizeSpoken("  THE   Lord  ")).toBe("the lord");
  });
});

describe("spokenMatches", () => {
  const text = "and he said unto them, the Lord's prayer";

  it("matches across punctuation and case", () => {
    expect(spokenMatches(text, "lords prayer")).toBe(true);
    expect(spokenMatches(text, "Lord's Prayer")).toBe(true);
  });

  it("refuses a query shorter than the transcript minimum", () => {
    // One or two characters match most of any transcript — a slow answer
    // that helps nobody.
    expect(MIN_TRANSCRIPT_QUERY).toBe(3);
    expect(spokenMatches(text, "th")).toBe(false);
    expect(spokenMatches(text, "the")).toBe(true);
  });

  it("is false for missing text rather than throwing", () => {
    expect(spokenMatches(undefined, "prayer")).toBe(false);
    expect(spokenMatches(text, "")).toBe(false);
  });
});

describe("videoMatches", () => {
  it("matches on title or notes with no transcript at all", () => {
    expect(videoMatches(sermon, "sunday")).toBe(true);
    expect(videoMatches(sermon, "philippians")).toBe(true);
    expect(videoMatches(other, "philippians")).toBe(false);
  });

  it("matches on what was SAID when title and notes do not", () => {
    expect(videoMatches(other, "anchor", "we dropped the anchor")).toBe(true);
  });
});

describe("searchLibrary", () => {
  const library = [sermon, other, { id: "vid-3", title: "Evening prayer", notes: "" }];

  it("finds a video by title, notes, or transcript", () => {
    expect(searchLibrary({ videos: library, query: "harbour" }).videos).toEqual([other]);
    expect(searchLibrary({ videos: library, query: "philippians" }).videos).toEqual([sermon]);
    expect(
      searchLibrary({
        videos: library,
        transcripts: { "vid-2": "we dropped the anchor" },
        query: "anchor",
      }).videos
    ).toEqual([other]);
  });

  it("preserves LIBRARY order rather than ranking", () => {
    // The admin arranged the library deliberately; a search that reshuffles
    // it is harder to scan, not easier.
    const result = searchLibrary({ videos: library, query: "r" });
    expect(result.videos.map((v) => v.id)).toEqual(["vid-1", "vid-2", "vid-3"]);
  });

  it("returns nothing for an empty query — not everything", () => {
    // The homepage already shows the library when nothing is typed.
    expect(searchLibrary({ videos: library, query: "" })).toEqual({
      videos: [],
      truncated: false,
      total: 0,
    });
    expect(searchLibrary({ videos: library, query: "   " }).videos).toEqual([]);
  });

  it("caps results and REPORTS the truncation with the true total", () => {
    const many = Array.from({ length: MAX_RESULTS + 5 }, (_, i) => ({
      id: `v${i}`,
      title: "Sunday service",
      notes: "",
    }));
    const result = searchLibrary({ videos: many, query: "sunday" });
    expect(result.videos).toHaveLength(MAX_RESULTS);
    expect(result.truncated).toBe(true);
    // The count is of MATCHES, not of what was returned — a viewer told
    // "60 of 60" when there are 65 has been misled.
    expect(result.total).toBe(MAX_RESULTS + 5);
  });

  it("does not report truncation when everything fits", () => {
    const result = searchLibrary({ videos: library, query: "harbour" });
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(1);
  });

  it("honours a smaller explicit limit", () => {
    const result = searchLibrary({ videos: library, query: "r", limit: 2 });
    expect(result.videos).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(3);
  });

  it("survives junk input", () => {
    expect(searchLibrary()).toEqual({ videos: [], truncated: false, total: 0 });
    expect(searchLibrary({ videos: null, query: "x" }).videos).toEqual([]);
    expect(searchLibrary({ videos: library, transcripts: null, query: "harbour" }).videos).toEqual([
      other,
    ]);
  });
});
