// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppearanceForTest } from "@/components/settings-store";
import { QuickSettings } from "./quick-settings";

describe("QuickSettings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetAppearanceForTest();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetAppearanceForTest();
  });

  function render(onOpenChange = vi.fn(), onSeeAllSettings = vi.fn()) {
    act(() => {
      root.render(
        <QuickSettings open onOpenChange={onOpenChange} onSeeAllSettings={onSeeAllSettings} />,
      );
    });
    return { onOpenChange, onSeeAllSettings };
  }

  function radio(value: string): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`);
    if (input === null) throw new Error(`Missing option ${value}`);
    return input;
  }

  it("is a labelled dialog with theme and density radio groups", () => {
    render();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Quick settings");
    const legends = Array.from(document.querySelectorAll("fieldset legend")).map(
      (legend) => legend.textContent,
    );
    expect(legends).toEqual(["Theme", "Density"]);
    const themes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="quick-settings-theme"]'),
    ).map((input) => input.value);
    expect(themes).toEqual(["system", "light", "dark"]);
    const densities = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="quick-settings-density"]'),
    ).map((input) => input.value);
    expect(densities).toEqual(["default", "comfortable", "compact"]);
    expect(radio("system").checked).toBe(true);
  });

  it("applies theme and density as soon as they are picked", () => {
    render();
    act(() => radio("dark").click());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(radio("dark").checked).toBe(true);

    act(() => radio("comfortable").click());
    expect(document.documentElement.getAttribute("data-density")).toBe("comfortable");
  });

  it("closes and opens the full settings page from See all settings", () => {
    const { onOpenChange, onSeeAllSettings } = render();
    const button = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent.trim() === "See all settings",
    );
    act(() => button?.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSeeAllSettings).toHaveBeenCalledTimes(1);
  });
});
