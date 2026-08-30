import { describe, expect, it } from "vitest";
import { groupId, isValidGroupName, resolveScope } from "../groups";

const groups = (...list) => Object.fromEntries(list.map((g) => [g.id, g]));

describe("groupId", () => {
  it("normalizes case, surrounding and inner whitespace", () => {
    expect(groupId("  Deck Crew ")).toBe("deck crew");
    expect(groupId("TEAM\tA")).toBe("team a");
    expect(groupId("Team   A")).toBe("team a");
  });

  it("is empty for blank input", () => {
    expect(groupId("")).toBe("");
    expect(groupId("   ")).toBe("");
    expect(groupId(null)).toBe("");
  });
});

describe("isValidGroupName", () => {
  it("accepts ordinary names and rejects blank or overlong ones", () => {
    expect(isValidGroupName("Deck crew")).toBe(true);
    expect(isValidGroupName("  ")).toBe(false);
    expect(isValidGroupName("x".repeat(30))).toBe(true);
    expect(isValidGroupName("x".repeat(31))).toBe(false);
  });
});

describe("resolveScope", () => {
  it("leaves an untagged viewer unrestricted", () => {
    expect(resolveScope([], groups())).toBe(null);
    expect(resolveScope(null, groups())).toBe(null);
  });

  // Every tag that existed before groups shipped has no group record, so it
  // must stay a plain label — this is the backwards-compatibility guarantee.
  it("leaves a tag with no group record unrestricted", () => {
    expect(resolveScope(["Team A"], groups())).toBe(null);
  });

  it("leaves an explicitly unrestricted group unrestricted", () => {
    const map = groups({ id: "team a", restricted: false, videoIds: ["v1"] });
    expect(resolveScope(["Team A"], map)).toBe(null);
  });

  it("restricts a member to its group's allowlist", () => {
    const map = groups({ id: "team a", restricted: true, videoIds: ["v1", "v2"] });
    expect(resolveScope(["Team A"], map)).toEqual(["v1", "v2"]);
  });

  it("matches the group by normalized name, not exact tag text", () => {
    const map = groups({ id: "deck crew", restricted: true, videoIds: ["v1"] });
    expect(resolveScope(["  DECK   Crew "], map)).toEqual(["v1"]);
  });

  it("unions the allowlists of several restricted groups, deduped", () => {
    const map = groups(
      { id: "a", restricted: true, videoIds: ["v1", "v2"] },
      { id: "b", restricted: true, videoIds: ["v2", "v3"] }
    );
    expect(resolveScope(["a", "b"], map).sort()).toEqual(["v1", "v2", "v3"]);
  });

  // The security-critical case: an unrestricted group must never widen a
  // restricted one back to the whole library, or any stray extra tag would
  // silently defeat the restriction.
  it("keeps a restriction when the viewer also holds unrestricted tags", () => {
    const map = groups(
      { id: "a", restricted: true, videoIds: ["v1"] },
      { id: "b", restricted: false, videoIds: ["v9"] }
    );
    expect(resolveScope(["a", "b", "some-loose-label"], map)).toEqual(["v1"]);
  });

  it("denies everything for a restricted group with an empty allowlist", () => {
    const map = groups({ id: "a", restricted: true, videoIds: [] });
    expect(resolveScope(["a"], map)).toEqual([]);
  });

  it("tolerates a malformed group record without granting access", () => {
    const map = groups({ id: "a", restricted: true, videoIds: null });
    expect(resolveScope(["a"], map)).toEqual([]);
  });
});
