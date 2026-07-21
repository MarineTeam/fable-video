import { describe, expect, it } from "vitest";
import { clampWatermarkMode, resolveWatermark } from "../watermark";

describe("clampWatermarkMode", () => {
  it("passes through valid modes", () => {
    expect(clampWatermarkMode("on")).toBe("on");
    expect(clampWatermarkMode("off")).toBe("off");
    expect(clampWatermarkMode("default")).toBe("default");
  });

  it("falls back to default for anything else", () => {
    expect(clampWatermarkMode("nonsense")).toBe("default");
    expect(clampWatermarkMode(undefined)).toBe("default");
    expect(clampWatermarkMode(null)).toBe("default");
  });
});

describe("resolveWatermark", () => {
  it("uses the global default when no other layer is set", () => {
    expect(resolveWatermark({ globalEnabled: true })).toBe(true);
    expect(resolveWatermark({ globalEnabled: false })).toBe(false);
  });

  it("a video override wins over the global default", () => {
    expect(resolveWatermark({ globalEnabled: false, videoMode: "on" })).toBe(true);
    expect(resolveWatermark({ globalEnabled: true, videoMode: "off" })).toBe(false);
  });

  it("a share override wins over the video override", () => {
    expect(
      resolveWatermark({ globalEnabled: false, videoMode: "off", shareMode: "on" })
    ).toBe(true);
    expect(
      resolveWatermark({ globalEnabled: true, videoMode: "on", shareMode: "off" })
    ).toBe(false);
  });

  it("an exemption wins over every other layer", () => {
    expect(
      resolveWatermark({
        globalEnabled: true,
        videoMode: "on",
        shareMode: "on",
        exempt: true,
      })
    ).toBe(false);
  });
});
