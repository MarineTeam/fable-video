// Sermon notes. Two things can go wrong quietly here: admin input stored in a
// shape the watch page renders badly, and a search that starts matching
// videos a viewer was never meant to be offered. The second is the one that
// matters, so videoMatchesQuery is tested as a pure predicate over an
// already-authorized list — it narrows, it never widens.
import { describe, expect, it } from "vitest";
import { MAX_NOTES_LENGTH, cleanNotes, notesLines, videoMatchesQuery } from "../notes";

describe("cleanNotes", () => {
  it("returns null for nothing, so the store deletes the row", () => {
    for (const input of ["", "   ", "\n\n", null, undefined]) {
      expect(cleanNotes(input)).toBeNull();
    }
  });

  it("normalizes CRLF and trims trailing whitespace per line", () => {
    expect(cleanNotes("First line   \r\nSecond line\t\r\n")).toBe("First line\nSecond line");
  });

  it("keeps a deliberate paragraph break but collapses longer runs", () => {
    expect(cleanNotes("One\n\nTwo\n\n\n\nThree")).toBe("One\n\nTwo\n\nThree");
  });

  it("strips control characters without touching ordinary punctuation", () => {
    expect(cleanNotes("Phil 4:13 — contentment")).toBe("Phil 4:13 —  contentment");
  });

  it("clamps at the maximum length", () => {
    const long = "x".repeat(MAX_NOTES_LENGTH + 500);
    expect(cleanNotes(long)).toHaveLength(MAX_NOTES_LENGTH);
  });
});

describe("notesLines", () => {
  it("splits on newlines so each line can be rendered as its own element", () => {
    expect(notesLines("One\n\nTwo")).toEqual(["One", "", "Two"]);
  });
});

describe("videoMatchesQuery", () => {
  const sermon = { title: "Sunday morning, 4 May", notes: "Philippians 4:10-20\nContentment" };
  const other = { title: "Youth evening", notes: null };

  it("matches on the title as it always did", () => {
    expect(videoMatchesQuery(sermon, "sunday")).toBe(true);
    expect(videoMatchesQuery(other, "sunday")).toBe(false);
  });

  it("matches a word that appears only in the notes", () => {
    expect(videoMatchesQuery(sermon, "philippians")).toBe(true);
    expect(videoMatchesQuery(other, "philippians")).toBe(false);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(videoMatchesQuery(sermon, "  CONTENTMENT ")).toBe(true);
  });

  // An empty query matches everything — the caller's other filters (collection)
  // still apply, and the list itself was already narrowed server-side.
  it("matches everything on an empty query", () => {
    expect(videoMatchesQuery(other, "")).toBe(true);
    expect(videoMatchesQuery(other, "   ")).toBe(true);
  });

  // The load-bearing property: this predicate only ever FILTERS the list it is
  // given. A video with no notes cannot be surfaced by a notes search, and
  // nothing here consults anything outside the video object it was handed —
  // so a viewer can never search their way to a video the server left out.
  it("never matches a video whose title and notes both miss", () => {
    expect(videoMatchesQuery(other, "contentment")).toBe(false);
    expect(videoMatchesQuery({ title: "", notes: "" }, "anything")).toBe(false);
    expect(videoMatchesQuery({}, "anything")).toBe(false);
  });
});
