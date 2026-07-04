// Browser-side palette application. The resolved theme is cached in
// localStorage so the pre-paint script in _document.js can apply it before
// first paint — returning visitors never see a color flicker.
export const THEME_CACHE_KEY = "pvp:theme";

export function applyResolvedTheme(resolved) {
  if (!resolved?.accent || !resolved?.accent2) return;
  const style = document.documentElement.style;
  style.setProperty("--accent", resolved.accent);
  style.setProperty("--accent-2", resolved.accent2);
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(resolved));
  } catch {
    // Storage unavailable (private mode) — colors still applied for this view.
  }
}
