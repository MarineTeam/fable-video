import { afterEach, describe, expect, it } from "vitest";
import { geoRestrictionEnabled, isAllowedCountry } from "../geo";

afterEach(() => {
  delete process.env.ALLOWED_COUNTRIES;
});

describe("geoRestrictionEnabled", () => {
  it("is disabled when ALLOWED_COUNTRIES is unset or empty", () => {
    expect(geoRestrictionEnabled()).toBe(false);
    process.env.ALLOWED_COUNTRIES = "";
    expect(geoRestrictionEnabled()).toBe(false);
    process.env.ALLOWED_COUNTRIES = " , ,";
    expect(geoRestrictionEnabled()).toBe(false);
  });

  it("is enabled once a country is configured", () => {
    process.env.ALLOWED_COUNTRIES = "US";
    expect(geoRestrictionEnabled()).toBe(true);
  });
});

describe("isAllowedCountry", () => {
  it("allows everything when unconfigured", () => {
    expect(isAllowedCountry("US")).toBe(true);
    expect(isAllowedCountry("RU")).toBe(true);
    expect(isAllowedCountry(null)).toBe(true);
  });

  it("matches configured codes case-insensitively and trims whitespace", () => {
    process.env.ALLOWED_COUNTRIES = " us, Ca ";
    expect(isAllowedCountry("US")).toBe(true);
    expect(isAllowedCountry("us")).toBe(true);
    expect(isAllowedCountry("ca")).toBe(true);
    expect(isAllowedCountry("MX")).toBe(false);
  });

  it("allows a missing/unknown country code rather than blocking", () => {
    process.env.ALLOWED_COUNTRIES = "US";
    expect(isAllowedCountry(null)).toBe(true);
    expect(isAllowedCountry("")).toBe(true);
  });
});
