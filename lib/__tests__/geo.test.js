import { describe, expect, it } from "vitest";
import {
  geoRestrictionActive,
  isAllowedCountry,
  isValidCountryCode,
  normalizeCountryCode,
} from "../geo";

describe("normalizeCountryCode / isValidCountryCode", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeCountryCode(" us ")).toBe("US");
  });

  it("validates 2-letter codes only", () => {
    expect(isValidCountryCode("US")).toBe(true);
    expect(isValidCountryCode(" ca ")).toBe(true);
    expect(isValidCountryCode("USA")).toBe(false);
    expect(isValidCountryCode("1")).toBe(false);
    expect(isValidCountryCode("")).toBe(false);
    expect(isValidCountryCode(null)).toBe(false);
  });
});

describe("isAllowedCountry", () => {
  it("allows everything when the list is empty", () => {
    expect(isAllowedCountry("US", [])).toBe(true);
    expect(isAllowedCountry("RU", [])).toBe(true);
    expect(isAllowedCountry(null, [])).toBe(true);
  });

  it("matches configured codes case-insensitively and trims whitespace", () => {
    expect(isAllowedCountry("US", [" us", "Ca "])).toBe(true);
    expect(isAllowedCountry("ca", [" us", "Ca "])).toBe(true);
    expect(isAllowedCountry("MX", [" us", "Ca "])).toBe(false);
  });

  it("allows a missing/unknown country code rather than blocking", () => {
    expect(isAllowedCountry(null, ["US"])).toBe(true);
    expect(isAllowedCountry("", ["US"])).toBe(true);
  });
});

describe("geoRestrictionActive", () => {
  it("is inactive unless enabled and at least one country is listed", () => {
    expect(geoRestrictionActive({ enabled: false, countries: [] })).toBe(false);
    expect(geoRestrictionActive({ enabled: false, countries: ["US"] })).toBe(false);
    expect(geoRestrictionActive({ enabled: true, countries: [] })).toBe(false);
  });

  it("is active once enabled with at least one country", () => {
    expect(geoRestrictionActive({ enabled: true, countries: ["US"] })).toBe(true);
  });
});
