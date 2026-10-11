// Apply the Helix appearance settings (theme / density / accent) before
// first paint to avoid a flash of the wrong theme. Mirrors
// src/components/settings-store.ts; that store re-applies on hydration.
(() => {
  const ACCENT_HUE = {
    violet: 290,
    blue: 250,
    cyan: 220,
    emerald: 150,
    red: 25,
    orange: 50,
    pink: 350,
    teal: 185,
  };
  let mode = "system";
  let density = "default";
  let accent = "violet";
  let fontScale = "default";
  try {
    const raw = localStorage.getItem("helix-appearance");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (["system", "light", "dark"].includes(parsed.theme)) mode = parsed.theme;
      if (["default", "comfortable", "compact"].includes(parsed.density)) {
        density = parsed.density;
      }
      if (["small", "default", "large", "xl"].includes(parsed.fontScale)) {
        fontScale = parsed.fontScale;
      }
      if (typeof parsed.accent === "string" && parsed.accent in ACCENT_HUE) {
        accent = parsed.accent;
      }
    }
  } catch (_) {
    /* localStorage unavailable — fall back to defaults */
  }
  const prefersDark =
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = mode === "system" ? (prefersDark ? "dark" : "light") : mode;
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-density", density);
  root.setAttribute("data-font-scale", fontScale);
  root.style.colorScheme = theme;
  root.style.setProperty("--accent-h", String(ACCENT_HUE[accent]));
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0a0a0b" : "#fafaf9");
})();
