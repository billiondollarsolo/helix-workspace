// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

type Store = typeof import("./settings-store");

/** A controllable prefers-color-scheme media query. */
function installColorScheme(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => query),
  );
  return {
    set(next: boolean) {
      query.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

async function loadStore(stored?: unknown): Promise<Store> {
  vi.resetModules();
  if (stored !== undefined) localStorage.setItem("helix-appearance", JSON.stringify(stored));
  return import("./settings-store");
}

describe("appearance settings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelector('meta[name="theme-color"]')?.remove();
    localStorage.clear();
  });

  it("defaults to System theme and Default density", async () => {
    installColorScheme(false);
    const store = await loadStore();
    const root = document.documentElement;
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.density).toBe("default");
    expect(store.THEME_OPTIONS.map((option) => option.label)).toEqual(["System", "Light", "Dark"]);
    expect(store.DENSITY_OPTIONS.map((option) => option.label)).toEqual([
      "Default",
      "Comfortable",
      "Compact",
    ]);
  });

  it("follows prefers-color-scheme live while on System", async () => {
    const scheme = installColorScheme(true);
    const store = await loadStore({ theme: "system" });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(store.resolveTheme("system")).toBe("dark");
    scheme.set(false);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("keeps an explicit theme when the system preference changes", async () => {
    const scheme = installColorScheme(false);
    await loadStore({ theme: "dark" });
    scheme.set(false);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("drops unknown stored values instead of aliasing them", async () => {
    installColorScheme(false);
    const store = await loadStore({ theme: "sepia", density: "roomy", accent: "#7c3aed" });
    store.setAppearance("fontScale", "large");
    expect(JSON.parse(localStorage.getItem("helix-appearance") ?? "{}")).toEqual({
      theme: "system",
      density: "default",
      accent: "violet",
      fontScale: "large",
    });
  });

  it("synchronizes density, scale, accent hue, and color scheme on the root", async () => {
    installColorScheme(false);
    const themeColor = document.createElement("meta");
    themeColor.name = "theme-color";
    document.head.append(themeColor);
    document.documentElement.style.setProperty("--bg", "rgb(10, 10, 11)");
    const store = await loadStore();

    store.applyAppearance({
      theme: "dark",
      density: "compact",
      accent: "emerald",
      fontScale: "large",
    });

    const root = document.documentElement;
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.density).toBe("compact");
    expect(root.dataset.fontScale).toBe("large");
    expect(root.style.colorScheme).toBe("dark");
    expect(root.style.getPropertyValue("--accent-h")).toBe("150");
    expect(themeColor.content).toBe("rgb(10, 10, 11)");
    expect(store.accentSwatch(150)).toBe("oklch(54% 0.21 150)");
    root.style.removeProperty("--bg");
  });
});
