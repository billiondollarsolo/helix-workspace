// @vitest-environment jsdom

import { setKeyboardShortcutsEnabled } from "@/components/settings-store";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalShortcuts } from "./global-shortcuts";
import { useShortcuts } from "./use-shortcuts";

const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

function keydown(
  init: KeyboardEventInit,
  target: EventTarget = document.activeElement ?? document.body,
) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
  });
}

function ComposeHarness({ onCompose }: { readonly onCompose: () => void }) {
  useShortcuts("mail", { "mail.compose": onCompose });
  return null;
}

describe("GlobalShortcuts", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onTogglePalette = vi.fn();
  const onOpenShortcutSettings = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <GlobalShortcuts
          onTogglePalette={onTogglePalette}
          onOpenShortcutSettings={onOpenShortcutSettings}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    setKeyboardShortcutsEnabled(true);
    vi.clearAllMocks();
  });

  const helpDialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

  it("opens a labelled, focus-trapped help dialog generated from the catalog on ?", async () => {
    keydown({ key: "?", shiftKey: true });
    await flushMicrotasks();

    const dialog = helpDialog();
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const labelId = dialog?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelId)?.textContent).toBe("Keyboard shortcuts");
    const headings = [...(dialog?.querySelectorAll("h2") ?? [])].map((h) => h.textContent);
    expect(headings).toEqual([
      "Anywhere",
      "Mail",
      "Open conversation",
      "Calendar",
      "Drive",
      "Chat",
      "Compose and dialogs",
    ]);
    expect(dialog?.textContent).toContain("Go to Mail inbox");
    expect(dialog?.textContent).toContain("Reply all");

    const list = dialog?.querySelector('[role="region"]');
    expect(list?.getAttribute("aria-label")).toBe("Shortcut list");
    expect(document.activeElement).toBe(list);
    [...(dialog?.querySelectorAll("button") ?? [])].at(-1)?.focus();
    keydown({ key: "Tab" });
    expect(document.activeElement).toBe(list);

    keydown({ key: "Escape" });
    expect(helpDialog()).toBeNull();
  });

  it("hands off to shortcut settings from the help dialog", async () => {
    keydown({ key: "?", shiftKey: true });
    await flushMicrotasks();
    act(() => {
      [...(helpDialog()?.querySelectorAll("button") ?? [])]
        .find((button) => button.textContent === "Shortcut settings")
        ?.click();
    });
    expect(helpDialog()).toBeNull();
    expect(onOpenShortcutSettings).toHaveBeenCalledTimes(1);
  });

  it("navigates with g sequences", () => {
    keydown({ key: "g" });
    keydown({ key: "i" });
    keydown({ key: "g" });
    keydown({ key: "t" });
    keydown({ key: "g" });
    keydown({ key: "r" });
    expect(navigate.mock.calls).toEqual([
      [{ to: "/mail", search: {} }],
      [{ to: "/mail", search: { folder: "sent" } }],
      [{ to: "/drive" }],
    ]);
  });

  it("toggles the command palette with Ctrl+K even from a text field", () => {
    const input = document.createElement("input");
    document.body.append(input);
    keydown({ key: "k", ctrlKey: true }, input);
    expect(onTogglePalette).toHaveBeenCalledTimes(1);
  });

  it("suppresses app shortcuts while another modal is open", () => {
    const onCompose = vi.fn();
    const harness = document.createElement("div");
    document.body.append(harness);
    const harnessRoot = createRoot(harness);
    act(() => harnessRoot.render(<ComposeHarness onCompose={onCompose} />));
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);

    keydown({ key: "c" });
    keydown({ key: "?", shiftKey: true });
    expect(onCompose).not.toHaveBeenCalled();
    expect(helpDialog()).toBeNull();

    modal.remove();
    keydown({ key: "c" });
    expect(onCompose).toHaveBeenCalledTimes(1);

    act(() => harnessRoot.unmount());
    keydown({ key: "c" });
    expect(onCompose).toHaveBeenCalledTimes(1);
  });

  it("honours the keyboard shortcuts off switch", () => {
    setKeyboardShortcutsEnabled(false);
    keydown({ key: "?", shiftKey: true });
    keydown({ key: "g" });
    keydown({ key: "i" });
    expect(helpDialog()).toBeNull();
    expect(navigate).not.toHaveBeenCalled();

    keydown({ key: "k", ctrlKey: true });
    expect(onTogglePalette).toHaveBeenCalledTimes(1);
  });
});
