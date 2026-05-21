// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ColorModeProvider,
  DialogProvider,
  WebPlatformProvider,
  createWebPlatformHost,
  useColorMode,
} from "@helix/sdk-web";
import { resetShellUiStoreForTest } from "@/components/shell-store";
import { registerPlatformShellContributions } from "@/plugins/platform-shell";
import { routeTree } from "@/routeTree.gen";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("AppShell sidebar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.documentElement.dataset.colorMode = "system";
    document.documentElement.className = "light";
    resetShellUiStoreForTest();
    window.scrollTo = () => undefined;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps a permanent compact app rail with hover labels", async () => {
    await renderShell();

    const rail = landmark("Primary navigation");
    expect(rail.className).toContain("w-16");
    const mailLink = link("Mail");
    expect(mailLink.title).toBe("Mail");
    expect(mailLink.textContent).toContain("Mail");

    await act(async () => {
      rail.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await Promise.resolve();
    });

    expect(rail.className).toContain("w-16");
    expect(button("Open help")).toBeTruthy();
    expect(landmark("Google workspace shortcuts")).toBeTruthy();
    expect(button("Open side panel")).toBeTruthy();
  });

  async function renderShell() {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const platformHost = createWebPlatformHost({
      queryClient,
      getColorMode: () => "system",
    });
    registerPlatformShellContributions(platformHost);
    const router = createRouter({
      routeTree,
      context: {
        queryClient,
        platformHost,
      },
      history: createMemoryHistory({
        initialEntries: ["/mail"],
      }),
    });

    await act(async () => {
      root.render(
        <ColorModeProvider>
          <WebPlatformProvider host={platformHost} useColorMode={useColorMode}>
            <DialogProvider>
              <QueryClientProvider client={queryClient}>
                <RouterProvider router={router} />
              </QueryClientProvider>
            </DialogProvider>
          </WebPlatformProvider>
        </ColorModeProvider>,
      );
      await router.load();
      await Promise.resolve();
    });
  }

  function button(name: string) {
    const element = container.querySelector(`button[aria-label="${name}"]`);
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error(`Missing button: ${name}`);
    }
    return element;
  }

  function link(name: string) {
    const element = container.querySelector(`a[aria-label="${name}"]`);
    if (!(element instanceof HTMLAnchorElement)) {
      throw new Error(`Missing link: ${name}`);
    }
    return element;
  }

  function landmark(name: string) {
    const element = container.querySelector(`[aria-label="${name}"]`);
    if (!(element instanceof HTMLElement)) {
      throw new Error(`Missing landmark: ${name}`);
    }
    return element;
  }
});
