// Group membership: the tag arithmetic and the plan.
//
// Membership is a TAG on a viewer, and tags are free text while group ids are
// the normalized form. That mismatch is where the quiet bugs live: a viewer
// carrying "team a" while the group is "Team A" is a member, and adding them
// again must not leave them carrying both. The plan is pure so an admin can be
// told what happened to every address they named, rather than "saved" over a
// list where three were typos.
import { describe, expect, it } from "vitest";
import {
  MAX_TAGS_PER_VIEWER,
  isGroupMember,
  membersOfGroup,
  planMembershipChange,
  withGroupMembership,
} from "../groups";

describe("withGroupMembership", () => {
  it("adds the group and leaves other tags alone", () => {
    expect(withGroupMembership(["Crew"], "Team A", true)).toEqual(["Crew", "Team A"]);
  });

  it("removes the group and leaves other tags alone", () => {
    expect(withGroupMembership(["Crew", "Team A"], "Team A", false)).toEqual(["Crew"]);
  });

  it("removes a CASE VARIANT, not just an exact match", () => {
    // "team a" and "Team A" are one membership — resolveScope reads both
    // through groupId. Leaving the variant behind would leave the group's
    // restriction in force after an admin removed someone from it.
    expect(withGroupMembership(["team a", "Crew"], "Team A", false)).toEqual(["Crew"]);
    expect(withGroupMembership(["TEAM   A"], "team a", false)).toEqual([]);
  });

  it("never leaves a viewer carrying two tags for one group", () => {
    expect(withGroupMembership(["team a"], "Team A", true)).toEqual(["Team A"]);
  });

  it("is idempotent", () => {
    const once = withGroupMembership(["Crew"], "Team A", true);
    expect(withGroupMembership(once, "Team A", true)).toEqual(once);
    const gone = withGroupMembership(once, "Team A", false);
    expect(withGroupMembership(gone, "Team A", false)).toEqual(gone);
  });

  it("returns a deduped, sorted list — the shape setViewerTags stores", () => {
    expect(withGroupMembership(["b", "a", "b", "  "], "c", true)).toEqual(["a", "b", "c"]);
  });

  it("does nothing for an empty group name", () => {
    expect(withGroupMembership(["Crew"], "   ", true)).toEqual(["Crew"]);
  });
});

describe("isGroupMember / membersOfGroup", () => {
  const viewers = [
    { email: "a@x.com", tags: ["Team A"] },
    { email: "b@x.com", tags: ["team a", "Crew"] },
    { email: "c@x.com", tags: ["Crew"] },
    { email: "d@x.com", tags: [] },
  ];

  it("matches across case and spacing", () => {
    expect(isGroupMember(["Team  A"], "team a")).toBe(true);
    expect(isGroupMember(["Crew"], "team a")).toBe(false);
    expect(isGroupMember(null, "team a")).toBe(false);
    expect(isGroupMember(["Team A"], "")).toBe(false);
  });

  it("lists members sorted, including case variants", () => {
    expect(membersOfGroup(viewers, "Team A")).toEqual(["a@x.com", "b@x.com"]);
    expect(membersOfGroup(viewers, "Crew")).toEqual(["b@x.com", "c@x.com"]);
    expect(membersOfGroup(viewers, "nobody")).toEqual([]);
    expect(membersOfGroup(null, "Team A")).toEqual([]);
  });
});

describe("planMembershipChange", () => {
  const viewers = [
    { email: "in@x.com", tags: ["Team A"] },
    { email: "out@x.com", tags: ["Crew"] },
    { email: "variant@x.com", tags: ["team a"] },
  ];

  it("plans an add", () => {
    const plan = planMembershipChange(viewers, "Team A", { add: ["out@x.com"] });
    expect(plan.added).toEqual(["out@x.com"]);
    expect(plan.writes).toEqual([{ email: "out@x.com", tags: ["Crew", "Team A"] }]);
  });

  it("plans a remove, including a case variant", () => {
    const plan = planMembershipChange(viewers, "Team A", {
      remove: ["in@x.com", "variant@x.com"],
    });
    expect(plan.removed).toEqual(["in@x.com", "variant@x.com"]);
    expect(plan.writes).toEqual([
      { email: "in@x.com", tags: [] },
      { email: "variant@x.com", tags: [] },
    ]);
  });

  it("reports an already-member add as a noop, and writes nothing", () => {
    const plan = planMembershipChange(viewers, "Team A", { add: ["in@x.com"] });
    expect(plan.noop).toEqual(["in@x.com"]);
    expect(plan.added).toEqual([]);
    expect(plan.writes).toEqual([]);
  });

  it("reports an already-absent remove as a noop", () => {
    const plan = planMembershipChange(viewers, "Team A", { remove: ["out@x.com"] });
    expect(plan.noop).toEqual(["out@x.com"]);
    expect(plan.writes).toEqual([]);
  });

  it("reports an address that is not an approved viewer, rather than creating one", () => {
    // Tagging cannot approve anybody — there is no viewer record to write to.
    // Saying so is the difference between a typo the admin fixes and a person
    // they believe is in the group.
    const plan = planMembershipChange(viewers, "Team A", { add: ["ghost@x.com"] });
    expect(plan.unknown).toEqual(["ghost@x.com"]);
    expect(plan.writes).toEqual([]);
  });

  it("lets REMOVE win when an address is named in both lists", () => {
    const plan = planMembershipChange(viewers, "Team A", {
      add: ["out@x.com"],
      remove: ["out@x.com"],
    });
    expect(plan.added).toEqual([]);
    expect(plan.noop).toEqual(["out@x.com"]);
  });

  it("normalizes and dedupes the addresses it was given", () => {
    const plan = planMembershipChange(viewers, "Team A", {
      add: [" OUT@x.com ", "out@x.com", ""],
    });
    expect(plan.added).toEqual(["out@x.com"]);
    expect(plan.writes).toHaveLength(1);
  });

  it("refuses an add that would exceed the tag cap, and says who", () => {
    const full = [{ email: "full@x.com", tags: Array.from({ length: MAX_TAGS_PER_VIEWER }, (_, i) => `t${i}`) }];
    const plan = planMembershipChange(full, "Team A", { add: ["full@x.com"] });
    expect(plan.overflow).toEqual(["full@x.com"]);
    expect(plan.writes).toEqual([]);
  });

  it("never refuses a REMOVE for the tag cap", () => {
    // The removal is what brings them back under it. Refusing would strand a
    // viewer in a group with no way out.
    const tags = Array.from({ length: MAX_TAGS_PER_VIEWER }, (_, i) => `t${i}`);
    tags[0] = "Team A";
    const plan = planMembershipChange([{ email: "full@x.com", tags }], "Team A", {
      remove: ["full@x.com"],
    });
    expect(plan.overflow).toEqual([]);
    expect(plan.removed).toEqual(["full@x.com"]);
  });

  it("plans nothing for an empty group name", () => {
    const plan = planMembershipChange(viewers, "  ", { add: ["out@x.com"] });
    expect(plan).toEqual({
      writes: [],
      added: [],
      removed: [],
      noop: [],
      unknown: [],
      overflow: [],
    });
  });
});
