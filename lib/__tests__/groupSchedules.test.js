// Per-group publish windows (lib/schedule.js): "also visible to this group
// during this window".
//
// The property everything else leans on is that group windows are ADDITIVE:
// they can only ever make a video visible to MORE people, never fewer. That
// is what makes a call site that forgets to pass the viewer's groups fail
// safe — it withholds an early preview, it never leaks.
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
  isLive,
  isLiveFor,
  isUsableGroupKey,
  MAX_GROUP_WINDOWS,
  pruneGroupFromSchedules,
  setSchedule,
  getSchedule,
  validateGroupWindows,
} = await import("../schedule");

const NOW = Date.parse("2026-09-24T12:00:00Z");
const PAST = "2026-09-20T00:00:00.000Z";
const SOON = "2026-09-27T00:00:00.000Z";
const LATER = "2026-10-01T00:00:00.000Z";

// Goes public on Sunday; the Youth group gets it from Wednesday.
const sundayRelease = {
  publishAt: SOON,
  expiresAt: null,
  groups: { youth: { publishAt: PAST, expiresAt: null } },
};

beforeEach(() => {
  hash = {};
});

describe("isLiveFor", () => {
  it("shows a member of an early-access group the video before everyone else", () => {
    expect(isLive(sundayRelease, NOW)).toBe(false);
    expect(isLiveFor(sundayRelease, ["youth"], NOW)).toBe(true);
  });

  it("does not show it to anyone outside that group", () => {
    expect(isLiveFor(sundayRelease, ["crew"], NOW)).toBe(false);
    expect(isLiveFor(sundayRelease, [], NOW)).toBe(false);
  });

  it("FAILS SAFE when a caller forgets the groups — the default window applies", () => {
    expect(isLiveFor(sundayRelease, undefined, NOW)).toBe(false);
    expect(isLiveFor(sundayRelease, null, NOW)).toBe(false);
  });

  it("is ADDITIVE: a group window can never hold back a video that is live by default", () => {
    const heldBack = {
      publishAt: PAST,
      expiresAt: null,
      groups: { youth: { publishAt: LATER, expiresAt: null } },
    };
    expect(isLiveFor(heldBack, ["youth"], NOW)).toBe(true);
  });

  it("extends access for a group after the default window has closed", () => {
    const extended = {
      publishAt: null,
      expiresAt: PAST,
      groups: { class: { publishAt: null, expiresAt: LATER } },
    };
    expect(isLiveFor(extended, ["class"], NOW)).toBe(true);
    expect(isLiveFor(extended, ["other"], NOW)).toBe(false);
  });

  it("respects the group window's own end", () => {
    const ended = { publishAt: SOON, expiresAt: null, groups: { youth: { publishAt: null, expiresAt: PAST } } };
    expect(isLiveFor(ended, ["youth"], NOW)).toBe(false);
  });

  it("never reads a group window off the object prototype", () => {
    const s = { publishAt: SOON, expiresAt: null, groups: {} };
    expect(isLiveFor(s, ["__proto__", "constructor", "toString"], NOW)).toBe(false);
  });

  it("treats a video with no schedule as live for everyone", () => {
    expect(isLiveFor(null, [], NOW)).toBe(true);
  });
});

describe("storing group windows", () => {
  it("round-trips a default window with group windows", async () => {
    await setSchedule("vid-1", sundayRelease);
    const read = await getSchedule("vid-1");
    expect(read).toEqual({
      publishAt: SOON,
      expiresAt: null,
      groups: { youth: { publishAt: PAST, expiresAt: null } },
    });
  });

  it("keeps a record that has ONLY group windows", async () => {
    await setSchedule("vid-1", { groups: { youth: { publishAt: PAST } } });
    expect((await getSchedule("vid-1")).groups).toEqual({ youth: { publishAt: PAST, expiresAt: null } });
  });

  it("drops a literal __proto__ group arriving from stored JSON", async () => {
    hash["vid-1"] = JSON.parse(
      `{"publishAt":"${SOON}","groups":{"__proto__":{"publishAt":"${PAST}"},"youth":{"publishAt":"${PAST}"}}}`
    );
    const read = await getSchedule("vid-1");
    expect(Object.keys(read.groups)).toEqual(["youth"]);
    expect(isLiveFor(read, ["__proto__"], NOW)).toBe(false);
  });

  it("drops empty and reserved group entries when reading", async () => {
    hash["vid-1"] = { publishAt: SOON, groups: { youth: {}, __proto__x: { publishAt: PAST }, constructor: { publishAt: PAST } } };
    const read = await getSchedule("vid-1");
    expect(Object.keys(read.groups)).toEqual(["__proto__x"]);
  });
});

describe("validateGroupWindows", () => {
  const known = ["youth", "crew"];

  it("accepts windows for groups that exist", () => {
    expect(validateGroupWindows({ youth: { publishAt: PAST } }, known)).toBeNull();
    expect(validateGroupWindows(null, known)).toBeNull();
  });

  it("refuses a group that does not exist, so no future group can inherit it", () => {
    expect(validateGroupWindows({ ghosts: { publishAt: PAST } }, known)).toMatch(/no longer exists/);
  });

  it("refuses a reserved key even if someone named a group that", () => {
    expect(validateGroupWindows(JSON.parse('{"__proto__": {"publishAt": "2026-09-20"}}'), ["__proto__"])).toMatch(
      /no longer exists/
    );
    expect(isUsableGroupKey("constructor")).toBe(false);
  });

  it("refuses a window that ends before it starts", () => {
    expect(validateGroupWindows({ youth: { publishAt: LATER, expiresAt: PAST } }, known)).toMatch(/after/);
  });

  it("caps how many group windows one video carries", () => {
    const many = Object.fromEntries(Array.from({ length: MAX_GROUP_WINDOWS + 1 }, (_, i) => [`g${i}`, { publishAt: PAST }]));
    expect(validateGroupWindows(many, Object.keys(many))).toMatch(/At most/);
  });
});

describe("pruneGroupFromSchedules", () => {
  it("removes a deleted group's windows everywhere, keeping everything else", async () => {
    await setSchedule("vid-1", sundayRelease);
    await setSchedule("vid-2", { publishAt: SOON, groups: { youth: { publishAt: PAST }, crew: { publishAt: PAST } } });
    await setSchedule("vid-3", { publishAt: SOON });
    expect(await pruneGroupFromSchedules("youth")).toBe(2);
    expect((await getSchedule("vid-1")).groups).toBeUndefined();
    expect((await getSchedule("vid-1")).publishAt).toBe(SOON);
    expect(Object.keys((await getSchedule("vid-2")).groups)).toEqual(["crew"]);
    expect(await getSchedule("vid-3")).toEqual({ publishAt: SOON, expiresAt: null });
  });

  it("deletes a record whose only content was that group's window", async () => {
    await setSchedule("vid-1", { groups: { youth: { publishAt: PAST } } });
    await pruneGroupFromSchedules("youth");
    expect(await getSchedule("vid-1")).toBeNull();
  });
});
