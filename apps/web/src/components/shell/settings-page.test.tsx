// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import { SettingsPage } from "./settings-page";

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: vi.fn(),
  useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }),
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
      data: {
        actorId: "actor-1",
        orgId: "org-1",
        displayName: "Morgan Lee",
        email: "morgan@example.com",
        pronouns: "",
        jobTitle: "",
        about: "",
      },
    } as never);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.style.overflow = "";
    vi.clearAllMocks();
  });

  it("labels editable profile controls and manages focus", async () => {
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
    const displayName = container.querySelector<HTMLInputElement>('input[name="displayName"]');
    expect(dialog?.getAttribute("aria-labelledby")).toBe("settings-title");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(
      container.querySelector<HTMLButtonElement>('button[aria-label="Back"]'),
    );
    expect(displayName?.labels?.[0]?.textContent).toBe("Display name");
    expect(displayName?.name).toBe("displayName");
    expect(displayName?.autocomplete).toBe("name");
    expect(displayName?.disabled).toBe(false);
    expect(displayName?.value).toBe("Morgan Lee");

    const upload = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Upload",
    );
    expect(upload).toBeUndefined();
    expect(container.querySelector('button[type="submit"]')?.textContent).toBe("Save profile");

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

  it.each(["ai", "shortcuts"] as const)("omits editor controls from %s settings", (section) => {
    act(() =>
      root.render(
        <SettingsPage
          open
          section={section}
          onSectionChange={() => undefined}
          onClose={() => undefined}
        />,
      ),
    );
    expect(container.querySelector("section[aria-label]")?.textContent).not.toMatch(
      /\bDocs\b|\bSheets\b|Go to Docs|Formula generation/,
    );
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
    expect(container.querySelector("section[aria-label]")?.getAttribute("aria-label")).toBe(
      "Language & region settings",
    );
  });
});
