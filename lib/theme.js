// Site palette: 7 presets plus custom hex accents, applied to all visitors
// via CSS variables. Chosen by admins in /admin -> Settings.

export const PRESETS = {
  ocean: { label: "Ocean", accent: "#38bdf8", accent2: "#818cf8" },
  emerald: { label: "Emerald", accent: "#34d399", accent2: "#2dd4bf" },
  sunset: { label: "Sunset", accent: "#fb923c", accent2: "#f472b6" },
  violet: { label: "Violet", accent: "#a78bfa", accent2: "#22d3ee" },
  rose: { label: "Rose", accent: "#fb7185", accent2: "#c084fc" },
  amber: { label: "Amber", accent: "#fbbf24", accent2: "#fb923c" },
  crimson: { label: "Crimson", accent: "#f87171", accent2: "#fbbf24" },
};

export const DEFAULT_PRESET = "ocean";

export function isValidHex(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || ""));
}

// Turns whatever is stored (or null, or junk) into a safe, fully-resolved
// theme: { preset, accent, accent2 }.
export function resolveTheme(theme) {
  if (
    theme &&
    theme.preset === "custom" &&
    isValidHex(theme.accent) &&
    isValidHex(theme.accent2)
  ) {
    return {
      preset: "custom",
      accent: theme.accent.toLowerCase(),
      accent2: theme.accent2.toLowerCase(),
    };
  }
  const preset = theme && PRESETS[theme.preset] ? theme.preset : DEFAULT_PRESET;
  return {
    preset,
    accent: PRESETS[preset].accent,
    accent2: PRESETS[preset].accent2,
  };
}
