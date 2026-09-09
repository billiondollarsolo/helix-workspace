// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DocumentSurfaceViewToggle,
  useDocumentSurfaceViewPreference,
  type DocumentSurfaceView,
} from "./view-preference";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("document surface view preference", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let stored: DocumentSurfaceView;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let getItem: ReturnType<typeof vi.fn>;
  let setItem: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stored = "list";
    document.cookie = "helix_csrf=test-csrf; path=/";
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getItem = vi.fn();
    setItem = vi.fn();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem,
        setItem,
        removeItem: vi.fn(),
        clear: vi.fn(),
      },
    });
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/v1/api/tools/drive.view.get") {
        return Promise.resolve(Response.json({ view: stored }));
      }
      if (url === "/v1/api/tools/drive.view.set") {
        if (typeof init?.body !== "string") throw new Error("Expected JSON request body.");
        const body = JSON.parse(init.body) as { readonly view: DocumentSurfaceView };
        stored = body.view;
        return Promise.resolve(Response.json({ view: stored }));
      }
      return Promise.resolve(Response.json({ error: "unexpected request" }, { status: 500 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it("reads and writes the server-owned card/list preference without localStorage", async () => {
    render();
    await settle();

    expect(container.querySelector("[data-view]")?.textContent).toBe("list");

    const cardButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.getAttribute("aria-label") === "Card view",
    );
    expect(cardButton).not.toBeNull();
    act(() => {
      cardButton?.click();
    });
    await settle();

    expect(container.querySelector("[data-view]")?.textContent).toBe("grid");
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/api/tools/drive.view.set",
      expect.objectContaining({ body: JSON.stringify({ view: "grid" }) }),
    );
    expect(stored).toBe("grid");
    expect(getItem).not.toHaveBeenCalledWith("helix.documentSurface.view");
    expect(setItem).not.toHaveBeenCalled();
  });

  function render() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
      );
    });
  }

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
});

function Harness() {
  const [view, setView] = useDocumentSurfaceViewPreference();
  return (
    <div>
      <span data-view>{view}</span>
      <DocumentSurfaceViewToggle view={view} onViewChange={setView} />
    </div>
  );
}
