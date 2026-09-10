// Apply the Helix appearance settings (theme / density / accent) before
// first paint to avoid a flash of the wrong theme. Mirrors
// src/components/settings-store.ts; that store re-applies on hydration.
(() => {
  const ACCENT_HUE = {
    "#7c3aed": 290,
    "#2563eb": 250,
    "#0891b2": 220,
    "#059669": 150,
    "#dc2626": 25,
    "#ea580c": 50,
    "#db2777": 350,
    "#475569": 260,
  };
  let theme = "light";
  let density = "compact";
  let accent = "#7c3aed";
  let fontScale = "default";
  try {
    const raw = localStorage.getItem("helix-appearance");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.theme === "dark") theme = "dark";
      if (parsed.density === "comfortable") density = "comfortable";
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
