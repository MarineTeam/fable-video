import { beforeEach, describe, expect, it } from "vitest";
import {
  blockedByEmailVerification,
  isEmailVerified,
  verifiedEmailRequired,
} from "../auth";

beforeEach(() => {
  process.env.ADMIN_EMAILS = "root@example.com";
  delete process.env.REQUIRE_VERIFIED_EMAIL;
});

describe("verifiedEmailRequired", () => {
  it("is off unless explicitly switched on", () => {
    expect(verifiedEmailRequired()).toBe(false);
    process.env.REQUIRE_VERIFIED_EMAIL = "";
    expect(verifiedEmailRequired()).toBe(false);
    process.env.REQUIRE_VERIFIED_EMAIL = "false";
    expect(verifiedEmailRequired()).toBe(false);
  });

  it("accepts the same truthy spellings as the other env flags", () => {
    for (const value of ["true", "1", "on", "yes", "TRUE", " On "]) {
      process.env.REQUIRE_VERIFIED_EMAIL = value;
      expect(verifiedEmailRequired()).toBe(true);
    }
  });
});

describe("isEmailVerified", () => {
  it("accepts a real boolean and the string form", () => {
    expect(isEmailVerified({ email_verified: true })).toBe(true);
    expect(isEmailVerified({ email_verified: "true" })).toBe(true);
  });

  // A missing claim must read as unverified: a connection that simply
  // doesn't send the field would otherwise disable the check silently.
  it("treats a missing, false, or odd claim as unverified", () => {
    expect(isEmailVerified({})).toBe(false);
    expect(isEmailVerified({ email_verified: false })).toBe(false);
    expect(isEmailVerified({ email_verified: "yes" })).toBe(false);
    expect(isEmailVerified(null)).toBe(false);
  });
});

describe("blockedByEmailVerification", () => {
  it("blocks nobody while enforcement is off", () => {
    expect(blockedByEmailVerification({ email: "a@b.co" })).toBe(false);
    expect(blockedByEmailVerification({ email: "a@b.co", email_verified: false })).toBe(
      false
    );
  });

  it("blocks an unverified session once enforcement is on", () => {
    process.env.REQUIRE_VERIFIED_EMAIL = "true";
    expect(blockedByEmailVerification({ email: "a@b.co" })).toBe(true);
    expect(blockedByEmailVerification({ email: "a@b.co", email_verified: false })).toBe(
      true
    );
  });

  it("allows a verified session once enforcement is on", () => {
    process.env.REQUIRE_VERIFIED_EMAIL = "true";
    expect(blockedByEmailVerification({ email: "a@b.co", email_verified: true })).toBe(
      false
    );
  });

  // The recovery path — the bootstrap admin is the one person who can switch
  // enforcement back off, so it must never be able to lock them out.
  it("never blocks an ADMIN_EMAILS address", () => {
    process.env.REQUIRE_VERIFIED_EMAIL = "true";
    expect(blockedByEmailVerification({ email: "root@example.com" })).toBe(false);
    expect(
      blockedByEmailVerification({ email: " ROOT@Example.com ", email_verified: false })
    ).toBe(false);
  });
});
