// Repeating (weekly) windows on a video's default schedule (lib/schedule.js).
//
// Every instant below is written in UTC with the local time it corresponds
// to in the rule's zone beside it, because the whole point of the time zone
// is that the two differ — and differ by a different amount across a
// daylight-saving change.
import { beforeEach, describe, expect, it, vi } from "vitest";

let hash = {};
vi.mock("../redis", () => ({
  k: (...parts) => ["fablevideo", ...parts].join(":"),
  redis: () => ({
    hgetall: async () => ({ ...hash }),
    hget: async (key, field) => hash[field] ?? null,
    hset: async (key, obj) => Object.assign(hash, obj),
    hdel: async (key, field) => {
      delete hash[field];
      return 1;
    },
  }),
}));

const {
  getSchedule,
  inRepeatSlot,
  isLive,
  isLiveFor,
  isValidTimeZone,
  pruneGroupFromSchedules,
  scheduleState,
  setSchedule,
  validateRepeat,
} = await import("../schedule");

const at = (iso) => Date.parse(iso);

// Sunday service, 09:00–13:00 London time.
const sundayMorning = { days: [0], start: "09:00", end: "13:00", timeZone: "Europe/London" };

beforeEach(() => {
  hash = {};
});

describe("inRepeatSlot", () => {
  it("is inside the slot on the right day at the right local time (summer, UTC+1)", () => {
    // Sun 2026-09-20 10:00 London = 09:00 UTC
    expect(inRepeatSlot(sundayMorning, at("2026-09-20T09:00:00Z"))).toBe(true);
  });

  it("is outside before the start and AT the end (end is exclusive)", () => {
    // 08:59 and 13:00 London
    expect(inRepeatSlot(sundayMorning, at("2026-09-20T07:59:00Z"))).toBe(false);
    expect(inRepeatSlot(sundayMorning, at("2026-09-20T12:00:00Z"))).toBe(false);
  });

  it("is outside on another day at the same time", () => {
    // Mon 10:00 London
    expect(inRepeatSlot(sundayMorning, at("2026-09-21T09:00:00Z"))).toBe(false);
  });

  it("uses the RULE's time zone, not UTC, and follows daylight saving", () => {
    // In winter London is UTC+0: 09:30 UTC is 09:30 local — inside.
    expect(inRepeatSlot(sundayMorning, at("2026-11-01T09:30:00Z"))).toBe(true);
    // The same UTC time in summer is 10:30 local — also inside; but 08:30 UTC
    // in summer is 09:30 local (inside) while 08:30 UTC in winter is 08:30
    // local (outside). One UTC time, two answers: the zone is doing the work.
    expect(inRepeatSlot(sundayMorning, at("2026-09-20T08:30:00Z"))).toBe(true);
    expect(inRepeatSlot(sundayMorning, at("2026-11-01T08:30:00Z"))).toBe(false);
  });

  it("works in a zone far from UTC, where the local DAY differs", () => {
    // Sun 09:00–13:00 in Los Angeles. Sun 17:00 UTC = Sun 10:00 PDT — inside.
    const la = { ...sundayMorning, timeZone: "America/Los_Angeles" };
    expect(inRepeatSlot(la, at("2026-09-20T17:00:00Z"))).toBe(true);
    // Mon 02:00 UTC is still Sun 19:00 in LA — Sunday, but after the slot.
    expect(inRepeatSlot(la, at("2026-09-21T02:00:00Z"))).toBe(false);
  });

  it("runs a slot past midnight into the next day", () => {
    const lateSaturday = { days: [6], start: "22:00", end: "02:00", timeZone: "UTC" };
    expect(inRepeatSlot(lateSaturday, at("2026-09-19T23:00:00Z"))).toBe(true); // Sat 23:00
    expect(inRepeatSlot(lateSaturday, at("2026-09-20T01:30:00Z"))).toBe(true); // Sun 01:30
    expect(inRepeatSlot(lateSaturday, at("2026-09-20T02:00:00Z"))).toBe(false); // Sun 02:00
    expect(inRepeatSlot(lateSaturday, at("2026-09-19T21:59:00Z"))).toBe(false); // Sat 21:59
    // A slot on SATURDAY night spills into SUNDAY — not into Saturday morning.
    expect(inRepeatSlot(lateSaturday, at("2026-09-19T01:00:00Z"))).toBe(false); // Sat 01:00
  });

  it("wraps Saturday night into Sunday across the end of the week", () => {
    const rule = { days: [6], start: "23:00", end: "01:00", timeZone: "UTC" };
    expect(inRepeatSlot(rule, at("2026-09-20T00:30:00Z"))).toBe(true); // Sun 00:30
  });

  it("covers several days", () => {
    const weekdays = { days: [1, 2, 3, 4, 5], start: "18:00", end: "20:00", timeZone: "UTC" };
    expect(inRepeatSlot(weekdays, at("2026-09-23T19:00:00Z"))).toBe(true); // Wed
    expect(inRepeatSlot(weekdays, at("2026-09-26T19:00:00Z"))).toBe(false); // Sat
  });

  it("treats a malformed stored rule as NO rule rather than taking the video down", () => {
    expect(inRepeatSlot({ days: [0], start: "9am", end: "13:00", timeZone: "UTC" })).toBe(true);
    expect(inRepeatSlot({ days: [0], start: "09:00", end: "13:00", timeZone: "Mars/Olympus" })).toBe(true);
  });
});

describe("repeat narrows the DEFAULT window", () => {
  const schedule = { publishAt: "2026-09-01T00:00:00.000Z", expiresAt: null, repeat: sundayMorning };

  it("is live inside both the dates and a slot, and not outside the slot", () => {
    expect(isLive(schedule, at("2026-09-20T09:00:00Z"))).toBe(true);
    expect(isLive(schedule, at("2026-09-21T09:00:00Z"))).toBe(false);
  });

  it("is not live inside a slot but before the publish date", () => {
    expect(isLive(schedule, at("2026-08-30T09:00:00Z"))).toBe(false);
  });

  it("does NOT bind a group's own window — leaders can preview outside service hours", () => {
    const withGroup = { ...schedule, groups: { leaders: { publishAt: "2026-09-01T00:00:00.000Z", expiresAt: null } } };
    const mondayMorning = at("2026-09-21T09:00:00Z");
    expect(isLiveFor(withGroup, ["leaders"], mondayMorning)).toBe(true);
    expect(isLiveFor(withGroup, ["crew"], mondayMorning)).toBe(false);
  });

  it("describes the between-slots state for the admin badge", () => {
    expect(scheduleState(schedule, at("2026-09-20T09:00:00Z"))).toBe("live");
    expect(scheduleState(schedule, at("2026-09-21T09:00:00Z"))).toBe("off-slot");
    expect(scheduleState(schedule, at("2026-08-30T09:00:00Z"))).toBe("scheduled");
  });
});

describe("validateRepeat", () => {
  it("accepts a sensible rule, and nothing at all", () => {
    expect(validateRepeat(sundayMorning)).toBeNull();
    expect(validateRepeat(null)).toBeNull();
  });

  it.each([
    [{ ...sundayMorning, days: [] }, /at least one day/],
    [{ ...sundayMorning, days: [7] }, /at least one day/],
    [{ ...sundayMorning, start: "9:00" }, /HH:MM/],
    [{ ...sundayMorning, end: "24:00" }, /HH:MM/],
    [{ ...sundayMorning, end: "09:00" }, /same time/],
    [{ ...sundayMorning, timeZone: "Nowhere/Special" }, /time zone/],
    [[1, 2], /not valid/],
  ])("refuses %j", (rule, message) => {
    expect(validateRepeat(rule)).toMatch(message);
  });

  it("knows a real time zone from a made-up one", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Nowhere/Special")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("storage", () => {
  it("round-trips a rule, and keeps a record that has ONLY a rule", async () => {
    await setSchedule("vid-1", { repeat: sundayMorning });
    expect(await getSchedule("vid-1")).toEqual({ publishAt: null, expiresAt: null, repeat: sundayMorning });
  });

  it("keeps the rule when a group's windows are pruned from the record", async () => {
    await setSchedule("vid-1", {
      repeat: sundayMorning,
      groups: { youth: { publishAt: "2026-09-01T00:00:00.000Z" } },
    });
    await pruneGroupFromSchedules("youth");
    expect((await getSchedule("vid-1")).repeat).toEqual(sundayMorning);
  });
});
