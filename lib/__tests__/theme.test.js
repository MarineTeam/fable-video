import { describe, expect, it } from "vitest";
import { DEFAULT_PRESET, isValidHex, PRESETS, resolveTheme } from "../theme";

describe("PRESETS", () => {
  it("ships 7 presets with valid hex colors", () => {
    expect(Object.keys(PRESETS)).toHaveLength(7);
    for (const preset of Object.values(PRESETS)) {
      expect(isValidHex(preset.accent)).toBe(true);
      expect(isValidHex(preset.accent2)).toBe(true);
    }
  });
});

describe("isValidHex", () => {
  it("accepts #RRGGBB only", () => {
    expect(isValidHex("#38bdf8")).toBe(true);
    expect(isValidHex("#38BDF8")).toBe(true);
    expect(isValidHex("38bdf8")).toBe(false);
    expect(isValidHex("#38bdf")).toBe(false);
    expect(isValidHex("#38bdf8ff")).toBe(false);
    expect(isValidHex("red")).toBe(false);
    expect(isValidHex(null)).toBe(false);
  });
});

describe("resolveTheme", () => {
  it("falls back to the default preset for junk input", () => {
    for (const junk of [null, undefined, {}, { preset: "nope" }, "ocean", 42]) {
      const resolved = resolveTheme(junk);
      expect(resolved.preset).toBe(DEFAULT_PRESET);
      expect(resolved.accent).toBe(PRESETS[DEFAULT_PRESET].accent);
    }
  });

  it("resolves a named preset", () => {
    const resolved = resolveTheme({ preset: "emerald" });
    expect(resolved).toEqual({
      preset: "emerald",
      accent: PRESETS.emerald.accent,
      accent2: PRESETS.emerald.accent2,
    });
  });

  it("accepts valid custom colors and lowercases them", () => {
    const resolved = resolveTheme({
      preset: "custom",
      accent: "#AABBCC",
      accent2: "#112233",
    });
    expect(resolved).toEqual({
      preset: "custom",
      accent: "#aabbcc",
      accent2: "#112233",
    });
  });

  it("rejects invalid custom colors by falling back", () => {
    const resolved = resolveTheme({
      preset: "custom",
      accent: "javascript:alert(1)",
      accent2: "#112233",
    });
    expect(resolved.preset).toBe(DEFAULT_PRESET);
  });
});
