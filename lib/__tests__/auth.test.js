import { beforeEach, describe, expect, it } from "vitest";
import { isEnvAdmin, isValidEmail, normalizeEmail, parseEmailList } from "../auth";

describe("isEnvAdmin", () => {
  beforeEach(() => {
    process.env.ADMIN_EMAILS = "Skipper@Example.com, mate@example.com";
  });

  it("matches admin emails case-insensitively and trims whitespace", () => {
    expect(isEnvAdmin("skipper@example.com")).toBe(true);
    expect(isEnvAdmin("  MATE@example.COM  ")).toBe(true);
  });

  it("rejects non-admins, empty, and missing emails", () => {
    expect(isEnvAdmin("stranger@example.com")).toBe(false);
    expect(isEnvAdmin("")).toBe(false);
    expect(isEnvAdmin(null)).toBe(false);
    expect(isEnvAdmin(undefined)).toBe(false);
  });

  it("handles an unset ADMIN_EMAILS", () => {
    delete process.env.ADMIN_EMAILS;
    expect(isEnvAdmin("skipper@example.com")).toBe(false);
  });
});

describe("normalizeEmail / isValidEmail", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeEmail("  A@B.Co ")).toBe("a@b.co");
  });

  it("validates plausible addresses", () => {
    expect(isValidEmail("person@example.com")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("a@b.c")).toBe(false); // 1-char TLD
    expect(isValidEmail("user@sub.domain.io")).toBe(true);
    expect(isValidEmail("a@@b.com")).toBe(false);
    expect(isValidEmail("@b.com")).toBe(false);
    expect(isValidEmail("a b@c.com")).toBe(false);
  });
});

describe("parseEmailList", () => {
  it("splits on commas, semicolons, and whitespace", () => {
    const { valid } = parseEmailList("a@x.com, b@x.com;c@x.com\nd@x.com e@x.com");
    expect(valid).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
      "e@x.com",
    ]);
  });

  it("dedupes case-insensitively and separates invalid entries", () => {
    const { valid, invalid } = parseEmailList("A@x.com, a@x.com, nope");
    expect(valid).toEqual(["a@x.com"]);
    expect(invalid).toEqual(["nope"]);
  });

  it("handles empty input", () => {
    expect(parseEmailList("")).toEqual({ valid: [], invalid: [] });
    expect(parseEmailList(null)).toEqual({ valid: [], invalid: [] });
  });
});


// isValidEmail was a single regex whose two [^\s@]+ runs both match dots, so
// the split around the literal dot was ambiguous — the pattern CodeQL flags as
// polynomial ReDoS. It is now linear. These lock in the ACCEPT SET of the
// regex it replaced, including the odd inputs that make the two easy rewrites
// (lastIndexOf, or a plain indexOf) wrong: both would reject these, because
// the character before the dot may itself be a dot.
describe("isValidEmail — accept set preserved from the replaced regex", () => {
  it("keeps accepting a multi-dot tail (the lastIndexOf trap)", () => {
    expect(isValidEmail("a@b.b.c")).toBe(true);
    expect(isValidEmail("a@b..com")).toBe(true);
  });

  it("keeps accepting a leading-dot domain (the indexOf trap)", () => {
    expect(isValidEmail("b@..bb.")).toBe(true);
    expect(isValidEmail("c@..cb")).toBe(true);
  });

  it("still rejects a domain whose only dot leaves too short a tail", () => {
    // Only dot is at index 0, so nothing precedes it — the replaced regex
    // required >= 1 character before the literal dot, and so does this.
    expect(isValidEmail("a@.com")).toBe(false);
    expect(isValidEmail("a@b.")).toBe(false);
    expect(isValidEmail("a@.c")).toBe(false);
  });
});
