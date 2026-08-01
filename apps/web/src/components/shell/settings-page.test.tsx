// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import { SettingsPage } from "./settings-page";

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("SettingsPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(useQuery).mockReturnValue({
      data: { name: "Morgan Lee", email: "morgan@example.com" },
    } as never);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.style.overflow = "";
    vi.clearAllMocks();
  });

  it("labels real controls, exposes unavailable actions honestly, and manages focus", async () => {
    const onClose = vi.fn();
    const onSectionChange = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    act(() => {
      root.render(
        <SettingsPage open section="profile" onSectionChange={onSectionChange} onClose={onClose} />,
      );
    });
    await act(async () => Promise.resolve());

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    const displayName = container.querySelector<HTMLInputElement>("#settings-display-name");
    expect(dialog?.getAttribute("aria-labelledby")).toBe("settings-title");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>('button[aria-label="Back"]'),
    );
    expect(container.querySelector('label[for="settings-display-name"]')?.textContent).toBe(
      "Display name",
    );
    expect(displayName?.name).toBe("displayName");
    expect(displayName?.autocomplete).toBe("name");
    expect(displayName?.disabled).toBe(true);

    const upload = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Upload",
    );
    expect(upload?.disabled).toBe(true);
    expect(upload?.title).toContain("not available");

    const shortcuts = Array.from(container.querySelectorAll<HTMLButtonElement>("nav button")).find(
      (button) => button.textContent?.includes("Keyboard shortcuts"),
    );
    act(() => shortcuts?.click());
    expect(onSectionChange).toHaveBeenCalledWith("shortcuts");

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <SettingsPage
          open={false}
          section="profile"
          onSectionChange={onSectionChange}
          onClose={onClose}
        />,
      );
    });
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("renders controlled deep-linked sections with labelled browser metadata", () => {
    act(() => {
      root.render(
        <SettingsPage
          open
          section="language"
          onSectionChange={() => undefined}
          onClose={() => undefined}
        />,
      );
    });

    const language = container.querySelector<HTMLSelectElement>("#settings-language");
    expect(container.querySelector('label[for="settings-language"]')?.textContent).toBe("Language");
    expect(language?.name).toBe("language");
    expect(language?.disabled).toBe(true);
    expect(container.querySelector("main")?.getAttribute("aria-label")).toBe(
      "Language & region settings",
    );
  });
});
