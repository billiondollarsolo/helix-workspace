// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./helix-dialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("Dialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.style.overflow = "";
  });

  it("labels, traps, and restores focus while locking background scroll", async () => {
    const close = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    act(() => {
      root.render(
        <Dialog
          title="Delete workspace"
          onClose={close}
          footer={<button type="button">Delete</button>}
        >
          <button type="button">Cancel</button>
        </Dialog>,
      );
    });
    await act(async () => Promise.resolve());

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(dialog?.getAttribute("aria-labelledby")).not.toBeNull();
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(buttons[0]);

    buttons.at(-1)?.focus();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(buttons[0]);

    act(() => {
      dialog?.click();
    });
    expect(close).not.toHaveBeenCalled();

    act(() => {
      container.querySelector<HTMLElement>(".dialog-backdrop")?.click();
    });
    expect(close).toHaveBeenCalledTimes(1);

    act(() => root.render(null));
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
