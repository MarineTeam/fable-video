import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SITE_NAME,
  MAX_SHORT_NAME_LENGTH,
  MAX_SITE_NAME_LENGTH,
  envSiteName,
  pageTitle,
  resolveSiteName,
  shortSiteName,
  validateSiteName,
} from "../siteName";

const ENV_KEYS = ["SITE_NAME", "NEXT_PUBLIC_SITE_NAME"];
const saved = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("envSiteName", () => {
  it("is empty when neither variable is set", () => {
    expect(envSiteName()).toBe("");
  });

  it("reads either variable, preferring the server-only one", () => {
    process.env.NEXT_PUBLIC_SITE_NAME = "Public Name";
    expect(envSiteName()).toBe("Public Name");
    process.env.SITE_NAME = "Server Name";
    expect(envSiteName()).toBe("Server Name");
  });

  it("trims surrounding whitespace", () => {
    process.env.SITE_NAME = "  Crew Videos  ";
    expect(envSiteName()).toBe("Crew Videos");
  });
});

describe("resolveSiteName", () => {
  it("prefers the stored value over the environment", () => {
    process.env.SITE_NAME = "From Env";
    expect(resolveSiteName("From Redis")).toBe("From Redis");
  });

  it("falls back to the environment, then the built-in default", () => {
    expect(resolveSiteName(null)).toBe(DEFAULT_SITE_NAME);
    process.env.SITE_NAME = "From Env";
    expect(resolveSiteName(null)).toBe("From Env");
  });

  // An empty header and a page title that is just "—" are worse than a
  // default nobody picked, so blank input must never survive.
  it("never returns an empty name", () => {
    for (const value of ["", "   ", null, undefined]) {
      expect(resolveSiteName(value)).toBe(DEFAULT_SITE_NAME);
    }
  });

  it("clamps an over-long stored value rather than rejecting it", () => {
    const long = "x".repeat(MAX_SITE_NAME_LENGTH + 20);
    expect(resolveSiteName(long)).toHaveLength(MAX_SITE_NAME_LENGTH);
  });

  it("coerces a non-string stored value", () => {
    expect(resolveSiteName(42)).toBe("42");
    expect(resolveSiteName({})).toBe("[object Object]");
  });
});

describe("validateSiteName", () => {
  it("accepts a normal name", () => {
    expect(validateSiteName("Crew Videos")).toBe(null);
    expect(validateSiteName("x".repeat(MAX_SITE_NAME_LENGTH))).toBe(null);
  });

  it("rejects blank and over-long names", () => {
    expect(validateSiteName("")).toMatch(/empty/i);
    expect(validateSiteName("   ")).toMatch(/empty/i);
    expect(validateSiteName("x".repeat(MAX_SITE_NAME_LENGTH + 1))).toMatch(
      new RegExp(String(MAX_SITE_NAME_LENGTH))
    );
  });
});

describe("shortSiteName", () => {
  it("passes a short name through unchanged", () => {
    expect(shortSiteName("Crew")).toBe("Crew");
  });

  it("truncates a name longer than the home-screen limit", () => {
    const long = "Marine Video Portal";
    expect(long.length).toBeGreaterThan(MAX_SHORT_NAME_LENGTH);
    const short = shortSiteName(long);
    expect(short).toHaveLength(MAX_SHORT_NAME_LENGTH);
    expect(long.startsWith(short)).toBe(true);
  });

  it("resolves the same way resolveSiteName does before shortening", () => {
    process.env.SITE_NAME = "Env Name";
    expect(shortSiteName(null)).toBe("Env Name");
    expect(shortSiteName(undefined)).toBe("Env Name");
    expect(shortSiteName("From Redis")).toBe("From Redis");
  });

  it("never returns an empty label", () => {
    expect(shortSiteName("")).toBe(DEFAULT_SITE_NAME.slice(0, MAX_SHORT_NAME_LENGTH));
  });
});

describe("pageTitle", () => {
  it("joins the page and site with an em dash", () => {
    expect(pageTitle("Library", "Crew Videos")).toBe("Library — Crew Videos");
  });

  it("returns the bare site name when there is no page part", () => {
    expect(pageTitle(null, "Crew Videos")).toBe("Crew Videos");
    expect(pageTitle("", "Crew Videos")).toBe("Crew Videos");
    expect(pageTitle("   ", "Crew Videos")).toBe("Crew Videos");
  });

  it("resolves the site name the same way everywhere else does", () => {
    expect(pageTitle("Library", null)).toBe(`Library — ${DEFAULT_SITE_NAME}`);
    process.env.SITE_NAME = "From Env";
    expect(pageTitle("Library", null)).toBe("Library — From Env");
  });
});
