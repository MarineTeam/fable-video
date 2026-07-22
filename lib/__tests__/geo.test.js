import { afterEach, describe, expect, it } from "vitest";
import {
  adminGeoWhitelist,
  geoWhitelist,
  isAllowedCountry,
  normalizeCountryCode,
  resolveGeoAccess,
} from "../geo";

afterEach(() => {
  delete process.env.GEO_WHITELIST;
  delete process.env.ADMIN_GEO_WHITELIST;
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
});
