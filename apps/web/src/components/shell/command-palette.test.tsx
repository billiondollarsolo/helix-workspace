// @vitest-environment jsdom

import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import { WebPlatformProvider, createWebPlatformHost } from "@helix/sdk-web";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./command-palette";

const navigateMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("CommandPalette", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    queryClient = new QueryClient();
    root = createRoot(container);
    navigateMock.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("renders registered platform commands, filters by keywords, and runs selections", () => {
    const run = vi.fn();
    const close = vi.fn();
    const host = createWebPlatformHost({
      queryClient,
      getColorMode: () => "system",
    });
    host.registerCommandPaletteItems([
      {
        id: "docs.ask-current",
        pluginId: "com.helix.docs",
        label: "Ask this document",
        group: "Document",
        keywords: ["question", "current doc"],
        shortcut: "Docs",
        run,
      },
    ]);

    render(host, close);

    expect(container.textContent ?? "").toContain("Ask this document");
    setSearchQuery("question");
    expect(container.textContent ?? "").toContain("Ask this document");
    expect(container.textContent ?? "").toContain("Docs");

    act(() => {
      buttonWithText("Ask this document").click();
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("renders disabled registered commands with reasons and does not run them", () => {
    const run = vi.fn();
    const close = vi.fn();
    const host = createWebPlatformHost({
      queryClient,
      getColorMode: () => "system",
    });
    host.registerCommandPaletteItems([
      {
        id: "slides.export-pdf",
        pluginId: "com.helix.slides",
        label: "Export deck as PDF",
        group: "Presentation",
        keywords: ["export"],
        disabledReason: "Resolve 2 media export blockers before export.",
        run,
      },
    ]);

    render(host, close);

    const button = buttonWithText("Export deck as PDF");
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Resolve 2 media export blockers before export.");
    expect(container.textContent ?? "").toContain("Resolve 2 media export blockers before export.");

    act(() => {
      button.click();
    });

    expect(run).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  function render(host: ReturnType<typeof createWebPlatformHost>, onClose: () => void): void {
    act(() => {
      root.render(
        <WebPlatformProvider
          host={host}
          useColorMode={() => ({
            mode: "system",
            resolvedMode: "light",
            setMode: () => undefined,
            toggle: () => undefined,
          })}
        >
          <CommandPalette open onClose={onClose} openSettings={() => undefined} />
        </WebPlatformProvider>,
      );
    });
  }

  function setSearchQuery(value: string): void {
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search apps, docs, people, actions"]',
    );
    if (input === null) {
      throw new Error("Missing command palette search input.");
    }
    act(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- native setter invoked via Reflect.apply with input receiver
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter === undefined) {
        throw new Error("Missing input value setter.");
      }
      Reflect.apply(setter, input, [value]);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function buttonWithText(text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes(text),
    );
    if (button === undefined) {
      throw new Error(`Missing button: ${text}`);
    }
    return button;
  }
});
