// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, settle, unmountAll } from "@/test/ui";
import { AppToaster, dismissNotification, notify, type NotifyCloseReason } from "./toast";

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 50 && !check(); attempt += 1) await settle();
  expect(check()).toBe(true);
}

function toaster(): HTMLElement | null {
  return document.querySelector("[data-sonner-toaster]");
}

describe("notify", () => {
  afterEach(() => {
    act(() => dismissNotification("t"));
    unmountAll();
  });

  it("renders in a labelled bottom-left region with an Undo action", async () => {
    const onAction = vi.fn();
    const onClose = vi.fn<(reason: NotifyCloseReason) => void>();
    mount(<AppToaster />);
    act(() => {
      notify({
        id: "t",
        message: "Conversation archived",
        action: { label: "Undo", onAction },
        onClose,
      });
    });
    await waitFor(() => document.body.textContent?.includes("Conversation archived") === true);

    const region = document.querySelector('section[aria-label^="Notifications"]');
    expect(region).not.toBeNull();
    expect(toaster()?.getAttribute("data-y-position")).toBe("bottom");
    expect(toaster()?.getAttribute("data-x-position")).toBe("left");

    const undo = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Undo",
    );
    click(undo ?? null);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("action");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reports a dismissal once and offers a labelled close button", async () => {
    const onClose = vi.fn<(reason: NotifyCloseReason) => void>();
    mount(<AppToaster />);
    act(() => {
      notify({ id: "t", message: "Could not send", tone: "error", onClose });
    });
    await waitFor(() => document.body.textContent?.includes("Could not send") === true);
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
    expect(close).not.toBeNull();
    click(close);
    await settle();
    expect(onClose).toHaveBeenCalledWith("dismissed");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
