// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ProfileMenu } from "./profile-menu";

const { navigate, invalidate, clear, setAppearance } = vi.hoisted(() => ({
  navigate: vi.fn(),
  invalidate: vi.fn(),
  clear: vi.fn(),
  setAppearance: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate, invalidate }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
  useQueryClient: vi.fn(),
}));

vi.mock("@/components/settings-store", () => ({
  ACCENT_OPTIONS: ["#7c3aed", "#2563eb"],
  setAppearance,
  useAppearance: (selector: (state: object) => unknown) =>
    selector({ theme: "light", density: "compact", accent: "#7c3aed" }),
}));

vi.mock("@/lib/auth", () => ({
  sessionUserQueryOptions: () => ({ queryKey: ["session-user"] }),
  signOut: vi.fn(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("ProfileMenu", () => {
  let container: HTMLDivElement;
  let root: Root;
  let anchor: HTMLButtonElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    anchor = document.createElement("button");
    document.body.append(anchor);
    anchor.focus();
    vi.mocked(useQuery).mockReturnValue({
      data: { name: "Mira", email: "mira@helix.test" },
    } as never);
    vi.mocked(useQueryClient).mockReturnValue({ clear } as never);
  });

  afterEach(() => {
    act(() => root.unmount());
    anchor.remove();
    container.remove();
    vi.clearAllMocks();
  });

  it("focuses its controls, supports menu keys, and restores focus with Escape", async () => {
    const onClose = vi.fn();
    const anchorRef = createRef<HTMLButtonElement>();
    anchorRef.current = anchor;
    act(() => {
      root.render(
        <ProfileMenu anchorRef={anchorRef} open onClose={onClose} openSettings={vi.fn()} />,
      );
    });
    await act(async () => Promise.resolve());

    const menu = container.querySelector<HTMLElement>('[role="menu"]');
    const controls = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(menu?.getAttribute("aria-label")).toBe("Profile & appearance");
    expect(document.activeElement).toBe(controls[0]);

    act(() => {
      menu?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(controls.at(-1));

    act(() => {
      menu?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(anchor);
  });

  it("routes privacy and help actions to real settings sections", async () => {
    const openSettings = vi.fn();
    const anchorRef = createRef<HTMLButtonElement>();
    anchorRef.current = anchor;
    act(() => {
      root.render(
        <ProfileMenu anchorRef={anchorRef} open onClose={vi.fn()} openSettings={openSettings} />,
      );
    });
    await act(async () => Promise.resolve());

    const click = (label: string) => {
      const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      act(() => button?.click());
    };
    click("Privacy & security");
    click("Help & shortcuts");

    expect(openSettings).toHaveBeenNthCalledWith(1, "security");
    expect(openSettings).toHaveBeenNthCalledWith(2, "shortcuts");
  });
});
