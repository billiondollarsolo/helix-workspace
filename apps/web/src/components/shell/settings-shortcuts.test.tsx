// @vitest-environment jsdom

import { keyboardShortcutsEnabled, setKeyboardShortcutsEnabled } from "@/components/settings-store";
import { SHORTCUT_CATALOG } from "@/lib/shortcuts/catalog";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ShortcutsSection } from "./settings-shortcuts";

describe("ShortcutsSection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<ShortcutsSection />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setKeyboardShortcutsEnabled(true);
  });

  const switchButton = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find(
      (button) => button.textContent === label,
    );

  it("lists every catalog shortcut", () => {
    const descriptions = [...container.querySelectorAll("dt")].map((node) => node.textContent);
    expect(descriptions).toEqual(
      expect.arrayContaining(Object.values(SHORTCUT_CATALOG).map((entry) => entry.description)),
    );
    expect(descriptions).toHaveLength(Object.keys(SHORTCUT_CATALOG).length);
  });

  it("turns keyboard shortcuts off and on, persisting the choice", () => {
    expect(switchButton("On")?.getAttribute("aria-pressed")).toBe("true");

    act(() => switchButton("Off")?.click());
    expect(keyboardShortcutsEnabled()).toBe(false);
    expect(window.localStorage.getItem("helix-keyboard-shortcuts")).toBe("off");
    expect(switchButton("Off")?.getAttribute("aria-pressed")).toBe("true");

    act(() => switchButton("On")?.click());
    expect(keyboardShortcutsEnabled()).toBe(true);
    expect(window.localStorage.getItem("helix-keyboard-shortcuts")).toBe("on");
  });
});
