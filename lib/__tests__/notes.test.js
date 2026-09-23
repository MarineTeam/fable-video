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

describe("videoMatchesQuery: passages", () => {
  const abbreviated = { title: "Humility", notes: "Text: Phil 1:27-2:11" };
  const spelled = { title: "Joy — Philippians 4:4", notes: null };
  const unrelated = { title: "Philemon", notes: "Philemon 1-25" };

  it("finds a passage written in a different spelling", () => {
    // Before: typing "Philippians" could not find "Phil".
    expect(videoMatchesQuery(abbreviated, "Philippians")).toBe(true);
    expect(videoMatchesQuery(abbreviated, "philippians 2")).toBe(true);
    expect(videoMatchesQuery(abbreviated, "Php 2:5")).toBe(true);
  });

  it("finds a passage that OVERLAPS the one searched, not only an equal one", () => {
    expect(videoMatchesQuery(abbreviated, "Philippians 1:30")).toBe(true);
    expect(videoMatchesQuery(abbreviated, "Philippians 2:12")).toBe(false);
  });

  it("does not match a different book", () => {
    expect(videoMatchesQuery(unrelated, "Philippians")).toBe(false);
    expect(videoMatchesQuery(spelled, "Philippians 2")).toBe(false);
  });

  it("only ADDS matches — everything the substring rule found is still found", () => {
    expect(videoMatchesQuery(spelled, "philippians 4:4")).toBe(true);
    expect(videoMatchesQuery(abbreviated, "phil")).toBe(true);
    expect(videoMatchesQuery(abbreviated, "humil")).toBe(true);
  });

  it("re-reads a video whose notes changed rather than serving a stale parse", () => {
    const video = { title: "Talk", notes: "John 3" };
    expect(videoMatchesQuery(video, "John 3:16")).toBe(true);
    video.notes = "Mark 1";
    expect(videoMatchesQuery(video, "John 3:16")).toBe(false);
    expect(videoMatchesQuery(video, "Mark 1:1")).toBe(true);
  });
});
