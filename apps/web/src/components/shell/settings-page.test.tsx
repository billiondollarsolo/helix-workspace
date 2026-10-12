// @vitest-environment jsdom

import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { profileQueryKeys } from "@/lib/profile";
import { axeViolations, settle, unmountAll } from "@/test/ui";
import { buttonNamed, typeInto } from "@/features/mail/settings/test-support";
import type { SettingsSectionId } from "./overlay-context";
import { SettingsPage } from "./settings-page";
import { searchSettings } from "./settings-sections";
import { mockApi, renderWithClient, sessionUser } from "./settings-test-support";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const profile = {
  actorId: sessionUser.actorId,
  orgId: "org-1",
  displayName: "Morgan Lee",
  email: "morgan@example.com",
  pronouns: "",
  jobTitle: "",
  about: "",
  avatarDataUrl: null,
};
const preferences = {
  language: null,
  timeZone: "Europe/Paris",
  dateFormat: null,
  timeFormat: "24h",
  weekStart: null,
  workingHours: null,
  mail: { readingPane: "none", density: "default", conversationView: true },
  updatedAt: null,
};

afterEach(() => {
  unmountAll();
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

function renderPage(section: SettingsSectionId, onSectionChange = vi.fn(), onClose = vi.fn()) {
  mockApi({ "/api/tools/account.preferences.get": preferences, "/api/profile": { profile } });
  const view = renderWithClient(
    <SettingsPage open section={section} onSectionChange={onSectionChange} onClose={onClose} />,
    (client) => client.setQueryData(profileQueryKeys.current, profile),
  );
  return { ...view, onSectionChange, onClose };
}

function navLabels(): string[] {
  return Array.from(document.querySelectorAll("nav li button")).map(
    (button) => button.querySelector("span span")?.textContent ?? "",
  );
}

describe("SettingsPage", () => {
  it("is a labelled modal that takes focus, closes on Escape and restores focus", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { onClose, rerender, onSectionChange } = renderPage("personal-info");
    await settle();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.getAttribute("aria-labelledby")).toBe("settings-title");
    expect(document.body.style.overflow).toBe("hidden");
    expect(dialog?.contains(document.activeElement)).toBe(true);
    const displayName = document.querySelector<HTMLInputElement>('input[name="displayName"]');
    expect(displayName?.labels?.[0]?.textContent).toBe("Display name");
    expect(displayName?.value).toBe("Morgan Lee");

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <SettingsPage
        open={false}
        section="profile"
        onSectionChange={onSectionChange}
        onClose={onClose}
      />,
    );
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("also hides app content that mounts behind it while it is open", async () => {
    let showContent = () => {};
    function Background() {
      const [ready, setReady] = useState(false);
      showContent = () => setReady(true);
      return ready ? <main>Loaded content</main> : <p>Loading</p>;
    }
    mockApi({ "/api/tools/account.preferences.get": preferences, "/api/profile": { profile } });
    renderWithClient(
      <div>
        <Background />
        <SettingsPage open section="profile" onSectionChange={vi.fn()} onClose={vi.fn()} />
      </div>,
      (client) => client.setQueryData(profileQueryKeys.current, profile),
    );
    await settle();
    expect(document.querySelector("p")?.inert).toBe(true);

    // A route swapping its loading state for content mounts a new sibling.
    act(() => showContent());
    await settle();
    const content = document.querySelector("main");
    expect(content?.inert).toBe(true);
    expect(content?.style.visibility).toBe("hidden");
  });

  it("groups the sections Workspace-style and opens the one you pick", async () => {
    const { onSectionChange } = renderPage("security");
    await settle();
    expect(navLabels()).toEqual([
      "Profile",
      "Personal info",
      "Security",
      "App passwords",
      "S3 access keys",
      "Language & region",
      "Appearance",
      "Keyboard shortcuts",
      "Mail",
    ]);
    expect(
      Array.from(document.querySelectorAll("nav h2")).map((heading) => heading.textContent),
    ).toEqual(["Account", "Preferences", "Apps"]);
    expect(document.querySelector('nav [aria-current="page"]')?.textContent).toContain("Security");
    buttonNamed("Keyboard shortcuts")?.click();
    expect(onSectionChange).toHaveBeenCalledWith("shortcuts");
    expect(document.querySelector("section[aria-label]")?.getAttribute("aria-label")).toBe(
      "Security settings",
    );
  });

  it("searches sections and individual settings, and Escape clears the search first", async () => {
    const { onSectionChange, onClose } = renderPage("profile");
    await settle();
    const search = document.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search?.labels?.[0]?.textContent).toBe("Search settings");
    typeInto(search, "time zone");
    expect(document.querySelector('nav [role="status"]')?.textContent).toBe("1 section found");
    expect(document.querySelector("nav li")?.textContent).toContain("Time zone");
    act(() => {
      search?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(search?.value).toBe("");

    typeInto(search, "sign out");
    expect(navLabels()).toEqual(["Security"]);
    (document.querySelector("nav li button") as HTMLButtonElement).click();
    expect(onSectionChange).toHaveBeenCalledWith("security");
    typeInto(search, "zzz");
    expect(document.querySelector('nav [role="status"]')?.textContent).toBe(
      "No settings match “zzz”",
    );
  });

  it("starts on the section list on small screens and walks back from a section", async () => {
    renderPage("profile");
    await settle();
    expect(buttonNamed("Close settings")).not.toBeNull();
    expect(buttonNamed("All settings")).toBeNull();
    buttonNamed("Language & region")?.click();
    await settle();
    expect(buttonNamed("All settings")).not.toBeNull();
    buttonNamed("All settings")?.click();
    await settle();
    expect(buttonNamed("All settings")).toBeNull();
  });

  it("opens deep links on the section itself, with tabs", async () => {
    const { onSectionChange } = renderPage("mail/filters");
    await settle();
    expect(buttonNamed("All settings")).not.toBeNull();
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "Filters and blocked addresses",
    );
    buttonNamed("Labels")?.click();
    expect(onSectionChange).toHaveBeenCalledWith("mail/labels");
  });

  it("has no axe violations on the home and language sections", async () => {
    renderPage("profile");
    await settle();
    expect(await axeViolations()).toEqual([]);
    unmountAll();
    renderPage("language");
    await settle();
    expect(await axeViolations()).toEqual([]);
  });
});

describe("searchSettings", () => {
  it("matches every word against section names, settings and keywords", () => {
    expect(searchSettings("dark mode").map((result) => result.section.id)).toEqual(["appearance"]);
    expect(searchSettings("2fa").map((result) => result.section.id)).toEqual(["security"]);
    expect(searchSettings("working hours")[0]?.matches).toEqual(["Working hours"]);
    expect(searchSettings("  ")).toEqual([]);
  });
});
