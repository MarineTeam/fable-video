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
