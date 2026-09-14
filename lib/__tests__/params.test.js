// Regression tests for CodeQL "type confusion through parameter tampering"
// (Critical), raised against `Number(req.body?.length)` in
// pages/api/admin/videos.js.
//
// The rule these pin: coercion is not validation. A parameter of the wrong
// TYPE is rejected, never bent into a plausible-looking value.
import { describe, expect, it } from "vitest";
import { isExplicitlyTrue, oneNumber, oneString, oneTrimmed } from "../params";

describe("oneString", () => {
  it("passes a string through", () => {
    expect(oneString("hello")).toBe("hello");
    expect(oneString("")).toBe("");
  });

  // The exact hazard: Next.js hands back string[] for a repeated query key,
  // and String(["a","b"]) is "a,b" — a value nobody sent.
  it("rejects an array instead of joining it", () => {
    expect(oneString(["a", "b"])).toBeNull();
    expect(oneString(["only-one"])).toBeNull();
  });

  it("rejects every other type rather than stringifying it", () => {
    for (const bad of [42, true, false, null, undefined, {}, () => {}]) {
      expect(oneString(bad)).toBeNull();
    }
  });
});

describe("oneTrimmed", () => {
  it("trims and returns a real value", () => {
    expect(oneTrimmed("  v1  ")).toBe("v1");
  });

  it("treats whitespace-only as absent", () => {
    expect(oneTrimmed("   ")).toBeNull();
    expect(oneTrimmed("")).toBeNull();
  });

  it("rejects an array, so a repeated key can't become an id", () => {
    expect(oneTrimmed(["v1", "v2"])).toBeNull();
  });
});

describe("oneNumber", () => {
  it("accepts a finite number", () => {
    expect(oneNumber(5400)).toBe(5400);
    expect(oneNumber(0)).toBe(0);
    expect(oneNumber(-1)).toBe(-1);
  });

  it("accepts a numeric string, since JSON and query strings both carry those", () => {
    expect(oneNumber("5400")).toBe(5400);
    expect(oneNumber("  90 ")).toBe(90);
  });

  // Number([5]) is 5 and Number(true) is 1 — both plausible-looking values
  // from inputs that were never numbers.
  it("rejects the values Number() would silently coerce", () => {
    expect(oneNumber([5])).toBe(0);
    expect(oneNumber([5, 6])).toBe(0);
    expect(oneNumber(true)).toBe(0);
    expect(oneNumber(false)).toBe(0);
    expect(oneNumber({})).toBe(0);
    expect(oneNumber(null)).toBe(0);
    expect(oneNumber(undefined)).toBe(0);
  });

  it("rejects non-finite values", () => {
    expect(oneNumber(NaN)).toBe(0);
    expect(oneNumber(Infinity)).toBe(0);
    expect(oneNumber("not a number")).toBe(0);
  });

  it("honours an explicit fallback", () => {
    expect(oneNumber(undefined, 720)).toBe(720);
    expect(oneNumber(["x"], 720)).toBe(720);
  });
});

describe("isExplicitlyTrue", () => {
  // This one gates whether a video is readable by the whole internet, so
  // "truthy" is nowhere near good enough.
  it("is true only for the boolean true", () => {
    expect(isExplicitlyTrue(true)).toBe(true);
  });

  it("is false for everything truthy-but-not-true", () => {
    for (const value of ["true", "yes", 1, [], {}, "1", -1]) {
      expect(isExplicitlyTrue(value)).toBe(false);
    }
  });

  it("is false for falsy values", () => {
    for (const value of [false, 0, "", null, undefined, NaN]) {
      expect(isExplicitlyTrue(value)).toBe(false);
    }
  });
});

// The specific shape of the reported finding, kept as a named test so the
// reason this module exists survives in the suite rather than only in a
// commit message.
describe("the reported finding: req.body.length on a non-object body", () => {
  it("a field named `length` reads the built-in when the body is an array", () => {
    const arrayBody = ["a", "b", "c"];
    // This is what the old code did — and it read 3, a value no caller sent.
    expect(arrayBody.length).toBe(3);
    expect(Number(arrayBody.length)).toBe(3);
    // The rename removes the collision entirely: there is no built-in
    // `durationSeconds` to fall back to.
    expect(arrayBody.durationSeconds).toBeUndefined();
    expect(oneNumber(arrayBody.durationSeconds, 0)).toBe(0);
  });

  it("holds for a string body too", () => {
    const stringBody = "hello";
    expect(stringBody.length).toBe(5);
    expect(oneNumber(stringBody.durationSeconds, 0)).toBe(0);
  });
});
