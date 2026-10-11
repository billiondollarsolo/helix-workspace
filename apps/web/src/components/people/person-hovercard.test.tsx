// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonRef } from "@/features/people/person-ref";
import { PersonHovercard } from "./person-hovercard";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn(() => Promise.resolve()) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const sam: PersonRef = {
  kind: "member",
  displayName: "Sam Patel",
  email: "sam@helix.test",
  actorId: "00000000-0000-4000-8000-000000000111",
  groupId: null,
  title: "Engineer",
  avatarDataUrl: null,
};

describe("PersonHovercard", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(person: PersonRef = sam) {
    act(() => {
      root.render(
        <PersonHovercard person={person}>
          {(trigger) => (
            <button type="button" {...trigger}>
              {person.displayName}
            </button>
          )}
        </PersonHovercard>,
      );
    });
  }

  const trigger = () => container.querySelector<HTMLButtonElement>("button");
  const card = () => container.querySelector('[role="dialog"]');
  const action = (name: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(
      (button) => button.textContent.trim() === name,
    );

  function openByFocus() {
    act(() => trigger()?.focus());
    act(() => {
      vi.advanceTimersByTime(500);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    navigate.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("opens after a delay on focus and shows the person's details", () => {
    render();
    act(() => trigger()?.focus());
    expect(card()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(card()?.getAttribute("aria-label")).toBe("Sam Patel contact card");
    expect(trigger()?.getAttribute("aria-expanded")).toBe("true");
    expect(trigger()?.getAttribute("aria-controls")).toBe(card()?.id);
    expect(card()?.textContent).toContain("sam@helix.test");
    expect(card()?.textContent).toContain("Engineer");
  });

  it("opens on hover and closes with Escape, returning focus", () => {
    render();
    act(() => {
      trigger()?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      vi.advanceTimersByTime(500);
    });
    expect(card()).not.toBeNull();

    act(() => {
      card()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it.each([
    ["Send email", { to: "/mail", search: { compose: "new", to: "sam@helix.test" } }],
    ["Chat", { to: "/chat", search: { dm: "00000000-0000-4000-8000-000000000111" } }],
    [
      "Schedule a meeting",
      { to: "/calendar", search: { create: "event", attendees: "sam@helix.test" } },
    ],
  ])("%s hands off to the app with prefilled params", (name, target) => {
    render();
    openByFocus();
    act(() => action(name)?.click());

    expect(navigate).toHaveBeenCalledWith(target);
    expect(card()).toBeNull();
  });

  it("copies the email address and announces it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render();
    openByFocus();

    await act(async () => {
      action("Copy email")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("sam@helix.test");
    expect(card()?.querySelector('[role="status"]')?.textContent).toBe("Email address copied.");
  });

  it("offers no chat for people outside the organization", () => {
    render({ ...sam, kind: "external", actorId: null, title: null });
    openByFocus();

    expect(action("Chat")).toBeUndefined();
    expect(action("Send email")).toBeDefined();
  });
});
