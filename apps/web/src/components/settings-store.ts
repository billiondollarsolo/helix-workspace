/* Helix appearance settings — theme / density / accent / font-scale.
   Productionized port of the prototype's `useTweaks` hook (tweaks-panel.jsx):
   a TanStack Store backed by localStorage. Applied to the document root as
   `data-theme`, `data-density`, `data-font-scale`, and the `--accent-h` hue
   custom property. */

import { Store } from "@tanstack/store";
import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark";
export type Density = "compact" | "comfortable";
export type FontScale = "small" | "default" | "large" | "xl";

/** Eight curated accent options. Hex → OKLCH hue. */
export const ACCENT_HUE: Readonly<Record<string, number>> = {
  "#7c3aed": 290, // violet (default)
  "#2563eb": 250, // blue
  "#0891b2": 220, // cyan
  "#059669": 150, // emerald
  "#dc2626": 25, // red
  "#ea580c": 50, // orange
  "#db2777": 350, // pink
  "#475569": 260, // slate
};

/** Ordered list of selectable accent hex values. */
export const ACCENT_OPTIONS: readonly string[] = Object.keys(ACCENT_HUE);

/** Valid font-scale values in display order. */
export const FONT_SCALE_OPTIONS: readonly { value: FontScale; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "xl", label: "XL" },
];

const VALID_FONT_SCALES: readonly string[] = FONT_SCALE_OPTIONS.map((option) => option.value);
function isValidFontScale(v: unknown): v is FontScale {
  return typeof v === "string" && VALID_FONT_SCALES.includes(v);
}

export interface AppearanceSettings {
  readonly theme: ThemeMode;
  readonly density: Density;
  /** Accent hex; must be a key of `ACCENT_HUE`. */
  readonly accent: string;
  /** Text size multiplier axis. */
  readonly fontScale: FontScale;
}

const DEFAULTS: AppearanceSettings = {
  theme: "light",
  density: "compact",
  accent: "#7c3aed",
  fontScale: "default",
};

const STORAGE_KEY = "helix-appearance";
const THEME_COLORS: Readonly<Record<ThemeMode, string>> = {
  light: "#fafaf9",
  dark: "#0a0a0b",
};

function readStorage(): AppearanceSettings {
  if (typeof window === "undefined") {
    return DEFAULTS;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULTS;
    }
    const parsed = JSON.parse(raw) as Partial<AppearanceSettings>;
    return {
      theme: parsed.theme === "dark" ? "dark" : "light",
      density: parsed.density === "comfortable" ? "comfortable" : "compact",
      accent:
        typeof parsed.accent === "string" && parsed.accent in ACCENT_HUE
          ? parsed.accent
          : DEFAULTS.accent,
      fontScale: isValidFontScale(parsed.fontScale) ? parsed.fontScale : DEFAULTS.fontScale,
    };
  } catch {
    return DEFAULTS;
  }
}

export const appearanceStore = new Store<AppearanceSettings>(readStorage());

/** Write the current settings to the document root. */
export function applyAppearance(settings: AppearanceSettings): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  root.setAttribute("data-theme", settings.theme);
  root.setAttribute("data-density", settings.density);
  root.setAttribute("data-font-scale", settings.fontScale);
  root.style.setProperty("--accent-h", String(ACCENT_HUE[settings.accent] ?? 290));
  root.style.colorScheme = settings.theme;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[settings.theme]);
}

// Persist + apply on every change.
appearanceStore.subscribe(() => {
  const state = appearanceStore.state;
  applyAppearance(state);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage may be unavailable (private mode) — non-fatal */
    }
  }
});

// Apply once at module load so the very first paint is correct.
applyAppearance(appearanceStore.state);

/** Update a single appearance key. */
export function setAppearance<K extends keyof AppearanceSettings>(
  key: K,
  value: AppearanceSettings[K],
): void {
  appearanceStore.setState((prev) => ({ ...prev, [key]: value }));
}

/** Toggle between light and dark. */
export function toggleTheme(): void {
  appearanceStore.setState((prev) => ({
    ...prev,
    theme: prev.theme === "dark" ? "light" : "dark",
  }));
}

/** Reset to defaults — used by tests. */
export function resetAppearanceForTest(): void {
  appearanceStore.setState(() => DEFAULTS);
}

/** Subscribe to a slice of the appearance store. */
export function useAppearance<T>(selector: (state: AppearanceSettings) => T): T {
  return useSyncExternalStore(
    (onChange) => {
      const subscription = appearanceStore.subscribe(onChange);
      return () => subscription.unsubscribe();
    },
    () => selector(appearanceStore.state),
    () => selector(appearanceStore.state),
  );
}
