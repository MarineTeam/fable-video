// lib/staffScopeRules.js — the pure rules of group-scoped staff.
import { describe, expect, it } from "vitest";
import { CAP, ALL_CAPABILITIES } from "../capabilities";
import { groupId as groupsGroupId } from "../groups";
import {
  GLOBAL_CAPABILITIES,
  capabilitiesUnderScope,
  effectiveScopeGroups,
  groupId,
  leavesUnrestricted,
  mayDeleteVideo,
  mayRemovePerson,
  normalizeScope,
  personInScope,
  placementGroup,
  scheduleGroupsProblem,
  tagChangeProblem,
  videoInScope,
} from "../staffScopeRules";

const group = (id, restricted, videoIds = [], collectionIds = []) => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  restricted,
  videoIds,
  collectionIds,
});
const groupMap = {
  youth: group("youth", true, ["v1", "v3"]),
  deck: group("deck", true, ["v2", "v3"], ["sermons"]),
  choir: group("choir", true, ["v4"]),
  open: group("open", false, ["v1"]),
};
const scoped = (scope, videoScope = ["v1", "v3"]) => ({ staffScope: scope, videoScope });
const unscoped = { staffScope: null, videoScope: null };

describe("the catalog split", () => {
  it("strips exactly the portal-wide capabilities under a scope, and nothing without one", () => {
    expect(GLOBAL_CAPABILITIES).toEqual([CAP.SETTINGS_MANAGE, CAP.ROLES_MANAGE, CAP.AUDIT_READ, CAP.BROADCAST_SEND]);
    const under = capabilitiesUnderScope(ALL_CAPABILITIES, ["youth"]);
    expect(under.some((c) => GLOBAL_CAPABILITIES.includes(c))).toBe(false);
    expect(under).toHaveLength(ALL_CAPABILITIES.length - GLOBAL_CAPABILITIES.length);
    expect(capabilitiesUnderScope(ALL_CAPABILITIES, null)).toEqual([...ALL_CAPABILITIES].sort());
  });

  it("strips them from a scope of NO groups too — [] is scoped, not unscoped", () => {
    expect(capabilitiesUnderScope([CAP.SETTINGS_MANAGE, CAP.VIDEOS_MANAGE], [])).toEqual([CAP.VIDEOS_MANAGE]);
  });
});

describe("normalizeScope", () => {
  it("keeps null as null and anything else as a list", () => {
    expect(normalizeScope(null)).toBeNull();
    expect(normalizeScope(undefined)).toBeNull();
    expect(normalizeScope([])).toEqual([]);
    expect(normalizeScope("youth")).toEqual([]);
    expect(normalizeScope([" Youth ", "youth", "DECK", ""])).toEqual(["deck", "youth"]);
  });

  it("uses exactly lib/groups.js's group ids", () => {
    for (const name of ["Deck Crew", "  deck   crew ", "YOUTH"]) {
      expect(groupId(name)).toBe(groupsGroupId(name));
    }
  });
});

describe("effectiveScopeGroups", () => {
  it("counts only restricted groups that exist", () => {
    expect(effectiveScopeGroups(["youth", "open", "gone"], groupMap)).toEqual(["youth"]);
    expect(effectiveScopeGroups(null, groupMap)).toBeNull();
  });
});

describe("people and videos in scope", () => {
  it("puts someone in scope by a restricted group they share with the scope", () => {
    const a = scoped(["youth"]);
    expect(personInScope(a, ["Youth"], groupMap)).toBe(true);
    expect(personInScope(a, ["Deck"], groupMap)).toBe(false);
    expect(personInScope(a, [], groupMap)).toBe(false);
    // An unrestricted group is a label and bounds nothing.
    expect(personInScope(scoped(["open"]), ["open"], groupMap)).toBe(false);
    expect(personInScope(unscoped, [], groupMap)).toBe(true);
  });

  it("reads videos from the resolved videoScope", () => {
    expect(videoInScope(scoped(["youth"]), "v1")).toBe(true);
    expect(videoInScope(scoped(["youth"]), "v2")).toBe(false);
    expect(videoInScope(scoped([], []), "v1")).toBe(false);
    expect(videoInScope(unscoped, "anything")).toBe(true);
  });
});

describe("the no-group hole (rule 2)", () => {
  it("knows when tags leave someone in no restricted group", () => {
    expect(leavesUnrestricted([], groupMap)).toBe(true);
    expect(leavesUnrestricted(["open", "label"], groupMap)).toBe(true);
    expect(leavesUnrestricted(["Youth"], groupMap)).toBe(false);
  });

  it("refuses taking someone out of their last restricted group", () => {
    expect(tagChangeProblem(scoped(["youth"]), ["Youth"], [], groupMap)).toMatch(/whole library/);
  });

  it("allows it while another restricted group remains", () => {
    expect(tagChangeProblem(scoped(["youth"]), ["Youth", "Deck"], ["Deck"], groupMap)).toBeNull();
  });

  it("refuses touching any tag that is not one of the caller's groups", () => {
    const a = scoped(["youth"]);
    expect(tagChangeProblem(a, ["Youth"], ["Youth", "Deck"], groupMap)).toMatch(/your own groups/);
    expect(tagChangeProblem(a, ["Youth", "Deck"], ["Youth"], groupMap)).toMatch(/your own groups/);
    expect(tagChangeProblem(a, ["Youth", "label"], ["Youth"], groupMap)).toMatch(/your own groups/);
  });

  it("does not limit an unscoped caller", () => {
    expect(tagChangeProblem(unscoped, ["Youth"], [], groupMap)).toBeNull();
  });
});

describe("shared people and videos (rule 3)", () => {
  it("lets a scoped caller remove only someone wholly inside their scope", () => {
    const a = scoped(["youth"]);
    expect(mayRemovePerson(a, ["Youth"], groupMap)).toBe(true);
    expect(mayRemovePerson(a, ["Youth", "Deck"], groupMap)).toBe(false);
    expect(mayRemovePerson(a, [], groupMap)).toBe(false);
    expect(mayRemovePerson(scoped(["youth", "deck"]), ["Youth", "Deck"], groupMap)).toBe(true);
  });

  it("lets a scoped caller delete only a video no other group can see", () => {
    const a = scoped(["youth"], ["v1", "v3"]);
    expect(mayDeleteVideo(a, { videoId: "v1" }, groupMap)).toBe(true);
    // v3 is on Deck's list too.
    expect(mayDeleteVideo(a, { videoId: "v3" }, groupMap)).toBe(false);
    // Out of scope altogether.
    expect(mayDeleteVideo(a, { videoId: "v2" }, groupMap)).toBe(false);
  });

  it("counts a grant through a collection, not only by id", () => {
    const a = scoped(["youth"], ["v1", "v3", "v9"]);
    expect(mayDeleteVideo(a, { videoId: "v9", collectionId: "" }, groupMap)).toBe(true);
    expect(mayDeleteVideo(a, { videoId: "v9", collectionId: "sermons" }, groupMap)).toBe(false);
  });

  it("ignores an unrestricted group's list — it bounds nobody", () => {
    expect(mayDeleteVideo(scoped(["youth"], ["v1"]), { videoId: "v1" }, groupMap)).toBe(true);
  });
});

describe("per-group publish windows", () => {
  const w = { publishAt: "2026-01-01T00:00:00.000Z", expiresAt: null };
  it("lets a scoped caller change only their own groups' windows", () => {
    const a = scoped(["youth"]);
    expect(scheduleGroupsProblem(a, { deck: w }, { deck: w, youth: w }, groupMap)).toBeNull();
    expect(scheduleGroupsProblem(a, { deck: w }, { youth: w }, groupMap)).toMatch(/your own groups/);
    expect(scheduleGroupsProblem(a, {}, { deck: w }, groupMap)).toMatch(/your own groups/);
    expect(scheduleGroupsProblem(unscoped, {}, { deck: w }, groupMap)).toBeNull();
  });
});

describe("placementGroup", () => {
  it("uses the named group if it is theirs, else their only one, else nothing", () => {
    expect(placementGroup(scoped(["youth"]), undefined, groupMap)).toBe("youth");
    expect(placementGroup(scoped(["youth", "deck"]), undefined, groupMap)).toBeNull();
    expect(placementGroup(scoped(["youth", "deck"]), "Deck", groupMap)).toBe("deck");
    expect(placementGroup(scoped(["youth"]), "choir", groupMap)).toBeNull();
    expect(placementGroup(scoped([]), undefined, groupMap)).toBeNull();
    expect(placementGroup(unscoped, "youth", groupMap)).toBeUndefined();
  });
});
