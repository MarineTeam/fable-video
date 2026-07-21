// Pure resolution logic for the email watermark feature. Four layers,
// evaluated in this order — each layer only applies when the one above it
// is silent ("default"): a per-recipient exemption always wins (forces the
// watermark off no matter what any other layer says); then a per-share
// override (Always/Never, set when the share link is created); then a
// per-video override (set by an admin on the video itself, Videos tab);
// then the global default (admin Settings). This module never touches
// Redis — callers gather the four inputs and this just decides.
export const WATERMARK_MODES = ["default", "on", "off"];

export function clampWatermarkMode(value) {
  return WATERMARK_MODES.includes(value) ? value : "default";
}

export function resolveWatermark({
  globalEnabled,
  videoMode = "default",
  shareMode = "default",
  exempt = false,
}) {
  if (exempt) return false;
  if (shareMode === "on") return true;
  if (shareMode === "off") return false;
  if (videoMode === "on") return true;
  if (videoMode === "off") return false;
  return Boolean(globalEnabled);
}
