// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUnsavedChangesWarning } from "./use-unsaved-changes-warning";

type MockBlockerState =
  | {
      readonly status: "idle";
      readonly current: undefined;
      readonly next: undefined;
      readonly action: undefined;
      readonly proceed: undefined;
      readonly reset: undefined;
    }
  | {
      readonly status: "blocked";
      readonly current: object;
      readonly next: object;
      readonly action: "PUSH";
      readonly proceed: () => void;
      readonly reset: () => void;
    };

const blocker = vi.hoisted<{ current: MockBlockerState }>(() => ({
  current: {
    status: "idle",
    current: undefined,
    next: undefined,
    action: undefined,
    proceed: undefined,
    reset: undefined,
  },
}));
const useBlockerMock = vi.hoisted(() => vi.fn(() => blocker.current));

vi.mock("@tanstack/react-router", async () => ({
  ...(await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")),
  useBlocker: useBlockerMock,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function Harness({ enabled }: { readonly enabled: boolean }) {
  return <>{useUnsavedChangesWarning(enabled, "document editor")}</>;
}

describe("useUnsavedChangesWarning", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    blocker.current = {
      status: "idle",
      current: undefined,
      next: undefined,
      action: undefined,
      proceed: undefined,
      reset: undefined,
    };
    useBlockerMock.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("enables router and before-unload blocking only while a draft is dirty", () => {
    act(() => root.render(<Harness enabled />));
    expect(useBlockerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        disabled: false,
        enableBeforeUnload: true,
        withResolver: true,
      }),
    );

    act(() => root.render(<Harness enabled={false} />));
    expect(useBlockerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        disabled: true,
        enableBeforeUnload: false,
      }),
    );
  });

  it("offers explicit stay and discard actions for blocked in-app navigation", () => {
    const proceed = vi.fn();
    const reset = vi.fn();
    blocker.current = {
      status: "blocked",
      current: {},
      next: {},
      action: "PUSH",
      proceed,
      reset,
    };

    act(() => root.render(<Harness enabled />));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      "Leave document editor?",
    );

    const stay = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Stay and keep editing",
    );
    const discard = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Discard draft and leave",
    );
    act(() => stay?.click());
    act(() => discard?.click());
    expect(reset).toHaveBeenCalledTimes(1);
    expect(proceed).toHaveBeenCalledTimes(1);
  });
});
