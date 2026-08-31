import { describe, expect, it } from "vitest";
import { isLive, scheduleState, validateWindow } from "../schedule";

const AT = new Date("2026-06-15T12:00:00.000Z").getTime();
const BEFORE = "2026-06-01T00:00:00.000Z";
const AFTER = "2026-07-01T00:00:00.000Z";

describe("isLive", () => {
  // The backwards-compatibility guarantee: a video with no schedule record
  // behaves exactly as every video did before scheduling existed.
  it("treats no schedule as always live", () => {
    expect(isLive(null, AT)).toBe(true);
    expect(isLive(undefined, AT)).toBe(true);
  });

  it("hides a video before its publish date", () => {
    expect(isLive({ publishAt: AFTER, expiresAt: null }, AT)).toBe(false);
  });

  it("shows a video once its publish date has passed", () => {
    expect(isLive({ publishAt: BEFORE, expiresAt: null }, AT)).toBe(true);
  });

  it("hides a video at and after its expiry", () => {
    expect(isLive({ publishAt: null, expiresAt: BEFORE }, AT)).toBe(false);
    expect(isLive({ publishAt: null, expiresAt: new Date(AT).toISOString() }, AT)).toBe(
      false
    );
  });

  it("shows a video inside a closed window and hides it outside", () => {
    const window = { publishAt: BEFORE, expiresAt: AFTER };
    expect(isLive(window, AT)).toBe(true);
    expect(isLive(window, new Date("2026-05-01T00:00:00.000Z").getTime())).toBe(false);
    expect(isLive(window, new Date("2026-08-01T00:00:00.000Z").getTime())).toBe(false);
  });

  it("accepts a Date or ISO string for now", () => {
    const window = { publishAt: BEFORE, expiresAt: AFTER };
    expect(isLive(window, "2026-06-15T12:00:00.000Z")).toBe(true);
  });
});

describe("scheduleState", () => {
  it("labels the three states", () => {
    expect(scheduleState(null, AT)).toBe("live");
    expect(scheduleState({ publishAt: AFTER }, AT)).toBe("scheduled");
    expect(scheduleState({ expiresAt: BEFORE }, AT)).toBe("expired");
    expect(scheduleState({ publishAt: BEFORE, expiresAt: AFTER }, AT)).toBe("live");
  });
});

describe("validateWindow", () => {
  it("accepts an empty, one-sided, or ordered window", () => {
    expect(validateWindow({})).toBe(null);
    expect(validateWindow({ publishAt: BEFORE })).toBe(null);
    expect(validateWindow({ expiresAt: AFTER })).toBe(null);
    expect(validateWindow({ publishAt: BEFORE, expiresAt: AFTER })).toBe(null);
  });

  it("rejects an unparseable date", () => {
    expect(validateWindow({ publishAt: "not a date" })).toMatch(/valid date/i);
    expect(validateWindow({ expiresAt: "nope" })).toMatch(/valid date/i);
  });

  it("rejects an expiry at or before the publish date", () => {
    expect(validateWindow({ publishAt: AFTER, expiresAt: BEFORE })).toMatch(/after/i);
    expect(validateWindow({ publishAt: BEFORE, expiresAt: BEFORE })).toMatch(/after/i);
  });
});
