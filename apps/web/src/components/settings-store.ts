/* Helix appearance settings — theme / density / accent / font-scale.
   A TanStack Store backed by localStorage. Applied to the document root as
   `data-theme` (always the resolved light or dark), `data-density`,
   `data-font-scale`, and the `--accent-h` hue custom property. The "system"
   theme follows `prefers-color-scheme` and re-applies when it changes. */

import { Store } from "@tanstack/store";
import { useSyncExternalStore } from "react";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type Density = "default" | "comfortable" | "compact";
export type FontScale = "small" | "default" | "large" | "xl";

export type Accent = "violet" | "blue" | "cyan" | "emerald" | "red" | "orange" | "pink" | "teal";

/** Eight curated accents in display order; `hue` drives `--accent-h`. */
export const ACCENT_OPTIONS: readonly { value: Accent; label: string; hue: number }[] = [
  { value: "violet", label: "Violet", hue: 290 },
  { value: "blue", label: "Blue", hue: 250 },
  { value: "cyan", label: "Cyan", hue: 220 },
  { value: "emerald", label: "Emerald", hue: 150 },
  { value: "red", label: "Red", hue: 25 },
  { value: "orange", label: "Orange", hue: 50 },
  { value: "pink", label: "Pink", hue: 350 },
  { value: "teal", label: "Teal", hue: 185 },
];

/** Swatch colour for an accent; matches the light-theme `--accent`. */
export function accentSwatch(hue: number): string {
  return `oklch(54% 0.21 ${hue})`;
}

/** Theme choices in display order. */
export const THEME_OPTIONS: readonly { value: ThemeMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Density choices in display order, named after the familiar mail settings. */
export const DENSITY_OPTIONS: readonly { value: Density; label: string; hint: string }[] = [
  { value: "default", label: "Default", hint: "Roomy rows with attachment previews" },
  { value: "comfortable", label: "Comfortable", hint: "Roomy rows without previews" },
  { value: "compact", label: "Compact", hint: "More rows on screen" },
];

/** Valid font-scale values in display order. */
export const FONT_SCALE_OPTIONS: readonly { value: FontScale; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "xl", label: "XL" },
];

function isOneOf<T extends string>(options: readonly { value: T }[], value: unknown): value is T {
  return typeof value === "string" && options.some((option) => option.value === value);
}

export interface AppearanceSettings {
  readonly theme: ThemeMode;
  readonly density: Density;
  readonly accent: Accent;
  /** Text size multiplier axis. */
  readonly fontScale: FontScale;
}

const DEFAULTS: AppearanceSettings = {
  theme: "system",
  density: "default",
  accent: "violet",
  fontScale: "default",
};

const STORAGE_KEY = "helix-appearance";
const PREFERS_DARK = "(prefers-color-scheme: dark)";

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
      theme: isOneOf(THEME_OPTIONS, parsed.theme) ? parsed.theme : DEFAULTS.theme,
      density: isOneOf(DENSITY_OPTIONS, parsed.density) ? parsed.density : DEFAULTS.density,
      accent: isOneOf(ACCENT_OPTIONS, parsed.accent) ? parsed.accent : DEFAULTS.accent,
      fontScale: isOneOf(FONT_SCALE_OPTIONS, parsed.fontScale)
        ? parsed.fontScale
        : DEFAULTS.fontScale,
    };
  } catch {
    return DEFAULTS;
  }
}

function prefersDark(): MediaQueryList | null {
  return typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? null
    : window.matchMedia(PREFERS_DARK);
}

/** The light/dark theme a mode renders as right now. */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode !== "system") {
    return mode;
  }
  return prefersDark()?.matches === true ? "dark" : "light";
}

const appearanceStore = new Store<AppearanceSettings>(readStorage());

/** Write the current settings to the document root. */
export function applyAppearance(settings: AppearanceSettings): void {
  if (typeof document === "undefined") {
    return;
  }
  const theme = resolveTheme(settings.theme);
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-density", settings.density);
  root.setAttribute("data-font-scale", settings.fontScale);
  const hue = ACCENT_OPTIONS.find((option) => option.value === settings.accent)?.hue ?? 290;
  root.style.setProperty("--accent-h", String(hue));
  root.style.colorScheme = theme;
  // Browser chrome follows the page background token of the applied theme.
  const background = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (background) {
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", background);
  }
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

// "System" tracks the operating-system preference live.
prefersDark()?.addEventListener("change", () => {
  if (appearanceStore.state.theme === "system") {
    applyAppearance(appearanceStore.state);
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

/** Switch to the opposite of what is on screen, as an explicit choice. */
export function toggleTheme(): void {
  appearanceStore.setState((prev) => ({
    ...prev,
    theme: resolveTheme(prev.theme) === "dark" ? "light" : "dark",
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

/** The theme on screen, re-rendering when "System" follows an OS change. */
export function useResolvedTheme(): ResolvedTheme {
  const mode = useAppearance((state) => state.theme);
  return useSyncExternalStore(
    (onChange) => {
      const query = prefersDark();
      query?.addEventListener("change", onChange);
      return () => query?.removeEventListener("change", onChange);
    },
    () => resolveTheme(mode),
    () => resolveTheme(mode),
  );
}
