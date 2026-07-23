import { afterEach, describe, expect, it } from "vitest";
import {
  adminGeoBypassEmails,
  adminGeoWhitelist,
  geoWhitelist,
  isAllowedCountry,
  normalizeCountryCode,
  resolveGeoAccess,
} from "../geo";

afterEach(() => {
  delete process.env.GEO_WHITELIST;
  delete process.env.ADMIN_GEO_WHITELIST;
  delete process.env.ADMIN_GEO_BYPASS_EMAILS;
});

describe("normalizeCountryCode", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeCountryCode(" us ")).toBe("US");
  });
});

describe("geoWhitelist / adminGeoWhitelist", () => {
  it("parses comma-separated env vars, trimmed and uppercased", () => {
    process.env.GEO_WHITELIST = " us, Ca ,,";
    process.env.ADMIN_GEO_WHITELIST = "gb";
    expect(geoWhitelist()).toEqual(["US", "CA"]);
    expect(adminGeoWhitelist()).toEqual(["GB"]);
  });

  it("is empty when unset", () => {
    expect(geoWhitelist()).toEqual([]);
    expect(adminGeoWhitelist()).toEqual([]);
  });
});

describe("adminGeoBypassEmails", () => {
  it("parses a comma-separated env var, trimmed and lowercased", () => {
    process.env.ADMIN_GEO_BYPASS_EMAILS = " Admin@Example.com , second@example.com,,";
    expect(adminGeoBypassEmails()).toEqual([
      "admin@example.com",
      "second@example.com",
    ]);
  });

  it("is empty when unset", () => {
    expect(adminGeoBypassEmails()).toEqual([]);
  });
});

describe("isAllowedCountry", () => {
  it("allows everything when the list is empty", () => {
    expect(isAllowedCountry("US", [])).toBe(true);
    expect(isAllowedCountry("RU", [])).toBe(true);
    expect(isAllowedCountry(null, [])).toBe(true);
  });

  it("matches configured codes and allows a missing/unknown code", () => {
    expect(isAllowedCountry("US", ["US", "CA"])).toBe(true);
    expect(isAllowedCountry("MX", ["US", "CA"])).toBe(false);
    expect(isAllowedCountry(null, ["US"])).toBe(true);
    expect(isAllowedCountry("", ["US"])).toBe(true);
  });
});

describe("resolveGeoAccess", () => {
  const base = {
    countryCode: "MX",
    geoEnabled: false,
    geoWhitelist: [],
    adminGeoEnabled: false,
    adminGeoWhitelist: [],
    email: null,
    adminGeoBypassEmails: [],
  };

  it("allows everything when both toggles are off", () => {
    expect(resolveGeoAccess(base)).toBe(true);
  });

  it("blocks a country outside GEO_WHITELIST once enabled", () => {
    expect(
      resolveGeoAccess({ ...base, geoEnabled: true, geoWhitelist: ["US"] })
    ).toBe(false);
    expect(
      resolveGeoAccess({
        ...base,
        countryCode: "US",
        geoEnabled: true,
        geoWhitelist: ["US"],
      })
    ).toBe(true);
  });

  it("an enabled but empty GEO_WHITELIST blocks nobody", () => {
    expect(resolveGeoAccess({ ...base, geoEnabled: true, geoWhitelist: [] })).toBe(
      true
    );
  });

  it("ADMIN_GEO_WHITELIST bypasses a GEO_WHITELIST block when both are enabled", () => {
    expect(
      resolveGeoAccess({
        countryCode: "MX",
        geoEnabled: true,
        geoWhitelist: ["US"],
        adminGeoEnabled: true,
        adminGeoWhitelist: ["MX"],
      })
    ).toBe(true);
  });

  it("the admin bypass list is ignored unless its own toggle is on", () => {
    expect(
      resolveGeoAccess({
        countryCode: "MX",
        geoEnabled: true,
        geoWhitelist: ["US"],
        adminGeoEnabled: false,
        adminGeoWhitelist: ["MX"],
      })
    ).toBe(false);
  });

  it("a missing country code is allowed through even with GEO_WHITELIST enabled", () => {
    expect(
      resolveGeoAccess({
        countryCode: null,
        geoEnabled: true,
        geoWhitelist: ["US"],
        adminGeoEnabled: false,
        adminGeoWhitelist: [],
      })
    ).toBe(true);
  });

  it("ADMIN_GEO_BYPASS_EMAILS bypasses a GEO_WHITELIST block with both toggles off", () => {
    expect(
      resolveGeoAccess({
        ...base,
        geoEnabled: true,
        geoWhitelist: ["US"],
        email: "Admin@Example.com",
        adminGeoBypassEmails: ["admin@example.com"],
      })
    ).toBe(true);
  });

  it("ADMIN_GEO_BYPASS_EMAILS bypasses even when adminGeoEnabled is off and the country isn't in ADMIN_GEO_WHITELIST", () => {
    expect(
      resolveGeoAccess({
        countryCode: "MX",
        geoEnabled: true,
        geoWhitelist: ["US"],
        adminGeoEnabled: false,
        adminGeoWhitelist: ["FR"],
        email: "admin@example.com",
        adminGeoBypassEmails: ["admin@example.com"],
      })
    ).toBe(true);
  });

  it("an email not on ADMIN_GEO_BYPASS_EMAILS still gets the normal check", () => {
    expect(
      resolveGeoAccess({
        ...base,
        geoEnabled: true,
        geoWhitelist: ["US"],
        email: "someone-else@example.com",
        adminGeoBypassEmails: ["admin@example.com"],
      })
    ).toBe(false);
  });

  it("a signed-out visitor (no email) is unaffected by ADMIN_GEO_BYPASS_EMAILS", () => {
    expect(
      resolveGeoAccess({
        ...base,
        geoEnabled: true,
        geoWhitelist: ["US"],
        email: null,
        adminGeoBypassEmails: ["admin@example.com"],
      })
    ).toBe(false);
  });
});
