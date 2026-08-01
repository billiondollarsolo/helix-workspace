// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";
import type { SettingsSectionId } from "./overlay-context";

const navigate = vi.fn();
let routeSearch: Record<string, unknown> = {};

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => <main id="main-content">Workspace</main>,
  useLocation: () => ({ pathname: "/docs" }),
  useNavigate: () => navigate,
  useSearch: () => routeSearch,
}));

vi.mock("@/components/shell/rail", () => ({
  Rail: ({
    onOpenLauncher,
    onOpenHelp,
  }: {
    readonly onOpenLauncher: () => void;
    readonly onOpenHelp: () => void;
  }) => (
    <>
      <button type="button" onClick={onOpenLauncher}>
        Apps
      </button>
      <button type="button" onClick={onOpenHelp}>
        Help
      </button>
    </>
  ),
}));

vi.mock("@/components/shell/app-launcher", () => ({
  AppLauncher: () => null,
}));

vi.mock("@/components/shell/notifications-panel", () => ({
  NotificationsPanel: () => null,
}));

vi.mock("@/components/shell/command-palette", () => ({
  CommandPalette: () => null,
}));

vi.mock("@/components/shell/settings-page", () => ({
  SettingsPage: ({
    open,
    section,
    onSectionChange,
    onClose,
  }: {
    readonly open: boolean;
    readonly section: SettingsSectionId;
    readonly onSectionChange: (section: SettingsSectionId) => void;
    readonly onClose: () => void;
  }) =>
    open ? (
      <div data-testid="settings" data-section={section}>
        <button type="button" onClick={() => onSectionChange("appearance")}>
          Appearance
        </button>
        <button type="button" onClick={onClose}>
          Done
        </button>
      </div>
    ) : null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === label,
  );
}

function applySearchUpdate(
  options: {
    readonly search: (previous: Record<string, unknown>) => Record<string, unknown>;
  },
  previous: Record<string, unknown>,
) {
  return options.search(previous);
}

describe("AppShell settings URL state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    routeSearch = { settings: "shortcuts", q: "launch" };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("opens deep-linked sections and preserves route search while changing or closing them", () => {
    act(() => root.render(<AppShell />));

    expect(container.querySelector('[data-testid="settings"]')?.getAttribute("data-section")).toBe(
      "shortcuts",
    );

    act(() => findButton(container, "Appearance")?.click());
    const sectionNavigation = navigate.mock.calls[0]?.[0] as {
      readonly to: string;
      readonly replace: boolean;
      readonly search: (previous: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(sectionNavigation.to).toBe("/docs");
    expect(sectionNavigation.replace).toBe(true);
    expect(applySearchUpdate(sectionNavigation, { q: "launch" })).toEqual({
      q: "launch",
      settings: "appearance",
    });

    act(() => findButton(container, "Done")?.click());
    const closeNavigation = navigate.mock.calls[1]?.[0] as {
      readonly to: string;
      readonly replace: boolean;
      readonly search: (previous: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(applySearchUpdate(closeNavigation, { q: "launch", settings: "appearance" })).toEqual({
      q: "launch",
      settings: undefined,
    });
  });

  it("routes Help to the keyboard-shortcuts section", () => {
    routeSearch = {};
    act(() => root.render(<AppShell />));
    act(() => findButton(container, "Help")?.click());

    const helpNavigation = navigate.mock.calls[0]?.[0] as {
      readonly search: (previous: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(applySearchUpdate(helpNavigation, { q: "launch" })).toEqual({
      q: "launch",
      settings: "shortcuts",
    });
  });
});
