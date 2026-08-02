// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { applyAppearance, resetAppearanceForTest } from "./settings-store";

describe("appearance browser integration", () => {
  afterEach(() => {
    document.querySelector('meta[name="theme-color"]')?.remove();
    resetAppearanceForTest();
  });

  it("synchronizes color scheme, browser chrome color, density, scale, and accent", () => {
    const themeColor = document.createElement("meta");
    themeColor.name = "theme-color";
    document.head.append(themeColor);

    applyAppearance({
      theme: "dark",
      density: "comfortable",
      accent: "#059669",
      fontScale: "large",
    });

    const root = document.documentElement;
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.density).toBe("comfortable");
    expect(root.dataset.fontScale).toBe("large");
    expect(root.style.colorScheme).toBe("dark");
    expect(root.style.getPropertyValue("--accent-h")).toBe("150");
    expect(themeColor.content).toBe("#0a0a0b");
  });
});
