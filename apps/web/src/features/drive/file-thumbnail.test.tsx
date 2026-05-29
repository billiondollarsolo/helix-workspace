// @vitest-environment jsdom

import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/auth";
import { FileThumbnail } from "./file-thumbnail";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const pdfJsMock = vi.hoisted(() => ({
  getDocument: vi.fn(),
  getPage: vi.fn(),
  render: vi.fn(),
  destroy: vi.fn(),
  GlobalWorkerOptions: { workerSrc: "" },
  VerbosityLevel: { ERRORS: 0 },
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: pdfJsMock.GlobalWorkerOptions,
  VerbosityLevel: pdfJsMock.VerbosityLevel,
  getDocument: pdfJsMock.getDocument,
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "/pdf.worker.mock.mjs",
}));

vi.mock("@/lib/auth", () => ({
  authenticatedFetch: vi.fn(),
}));

describe("FileThumbnail", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalGetContextDescriptor: PropertyDescriptor | undefined;
  let originalToDataURLDescriptor: PropertyDescriptor | undefined;
  let originalIntersectionObserver: typeof IntersectionObserver | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(authenticatedFetch).mockReset();
    pdfJsMock.getDocument.mockReset();
    pdfJsMock.getPage.mockReset();
    pdfJsMock.render.mockReset();
    pdfJsMock.destroy.mockReset();
    pdfJsMock.GlobalWorkerOptions.workerSrc = "";
    originalGetContextDescriptor = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "getContext",
    );
    originalToDataURLDescriptor = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "toDataURL",
    );
    originalIntersectionObserver = globalThis.IntersectionObserver;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    if (originalGetContextDescriptor !== undefined) {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", originalGetContextDescriptor);
    }
    if (originalToDataURLDescriptor !== undefined) {
      Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", originalToDataURLDescriptor);
    }
    if (originalIntersectionObserver === undefined) {
      Reflect.deleteProperty(globalThis, "IntersectionObserver");
    } else {
      globalThis.IntersectionObserver = originalIntersectionObserver;
    }
  });

  function render(element: ReactElement) {
    act(() => {
      root.render(element);
    });
  }

  it("renders image previews from Drive preview metadata", () => {
    render(
      <FileThumbnail
        objectId="image-1"
        name="diagram.png"
        preview={{
          kind: "image",
          status: "available",
          mimeType: "image/png",
          url: "https://cdn.example/diagram.png",
        }}
      />,
    );

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://cdn.example/diagram.png",
    );
  });

  it("renders browser-supported image previews from file metadata when preview metadata is absent", () => {
    render(<FileThumbnail objectId="image-2" name="testGIF.gif" mimeType="image/gif" />);

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/api/drive/objects/image-2/preview",
    );
  });

  it("renders SVG thumbnails through the safe generated preview endpoint", () => {
    render(
      <FileThumbnail
        objectId="svg-1"
        name="scripted.svg"
        mimeType="image/svg+xml"
        fallback={<span>SVG</span>}
      />,
    );

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/api/drive/objects/svg-1/preview",
    );
  });

  it("renders uncommon image thumbnails through the generated preview endpoint", () => {
    render(<FileThumbnail objectId="heic-1" name="photo.HEIC" mimeType="image/heic" />);

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/api/drive/objects/heic-1/preview",
    );
  });

  it("infers JPEG 2000 and JPEG XL thumbnails from extension when MIME is generic", () => {
    render(
      <>
        <FileThumbnail objectId="jp2-1" name="scan.jp2" mimeType="application/octet-stream" />
        <FileThumbnail objectId="jxl-1" name="photo.jxl" mimeType="application/octet-stream" />
      </>,
    );

    expect(
      [...container.querySelectorAll("img")].map((image) => image.getAttribute("src")),
    ).toEqual([
      "/api/drive/objects/jp2-1/preview",
      "/api/drive/objects/jxl-1/preview",
    ]);
  });

  it("renders DOCX HTML previews as safe document thumbnails without injecting HTML", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(
        `<!doctype html><main><div class="doc"><h1>Launch plan</h1><p>First milestone</p><script>window.bad = true</script></div></main>`,
        { headers: { "content-type": "text/html" } },
      ),
    );

    render(
      <FileThumbnail
        objectId="docx-1"
        name="launch.docx"
        mimeType="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        preview={{
          kind: "office",
          status: "unsupported",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }}
        fallback={<span>DOCX</span>}
      />,
    );
    await flushAsyncEffects();

    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledWith(
      "/api/drive/objects/docx-1/preview",
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("Launch plan");
    expect(container.textContent).toContain("First milestone");
  });

  it("renders spreadsheet HTML previews as mini tables for legacy Excel uploads", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(
        `<!doctype html><main><div class="doc"><h2>Legacy</h2><table><tbody><tr><td>Customer</td><td>ARR</td></tr><tr><td>Acme</td><td>1200</td></tr></tbody></table></div></main>`,
        { headers: { "content-type": "text/html" } },
      ),
    );

    render(
      <FileThumbnail
        objectId="xls-1"
        name="forecast.xls"
        mimeType="application/vnd.ms-excel"
        preview={{
          kind: "office",
          status: "unsupported",
          mimeType: "application/vnd.ms-excel",
        }}
        fallback={<span>XLS</span>}
      />,
    );
    await flushAsyncEffects();

    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledWith(
      "/api/drive/objects/xls-1/preview",
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelectorAll("table td")).toHaveLength(4);
    expect(container.textContent).toContain("Customer");
    expect(container.textContent).toContain("1200");
  });

  it("renders PPTX HTML previews as safe presentation thumbnails", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(
        `<!doctype html><main><div class="doc"><section class="slide-card"><h2>Launch narrative</h2><ul><li>Customer proof</li><li>Rollout risk</li></ul><script>window.bad = true</script></section></div></main>`,
        { headers: { "content-type": "text/html" } },
      ),
    );

    render(
      <FileThumbnail
        objectId="pptx-1"
        name="board-review.pptx"
        mimeType="application/vnd.openxmlformats-officedocument.presentationml.presentation"
        preview={{
          kind: "office",
          status: "unsupported",
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }}
        fallback={<span>PPTX</span>}
      />,
    );
    await flushAsyncEffects();

    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledWith(
      "/api/drive/objects/pptx-1/preview",
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("Launch narrative");
    expect(container.textContent).toContain("Customer proof");
  });

  it("waits until a thumbnail is near the viewport before fetching HTML previews", async () => {
    let intersectionCallback: IntersectionObserverCallback | null = null;
    globalThis.IntersectionObserver = class {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      disconnect = vi.fn();
      observe = vi.fn();
      takeRecords = vi.fn(() => []);
      unobserve = vi.fn();
      readonly root = null;
      readonly rootMargin = "800px 0px";
      readonly thresholds = [0];
    };
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(
        `<!doctype html><main><div class="doc"><table><tbody><tr><td>Visible</td></tr></tbody></table></div></main>`,
        { headers: { "content-type": "text/html" } },
      ),
    );

    render(
      <FileThumbnail
        objectId="lazy-xls-1"
        name="lazy.xls"
        mimeType="application/vnd.ms-excel"
        preview={{ kind: "office", status: "unsupported", mimeType: "application/vnd.ms-excel" }}
        fallback={<span>Lazy</span>}
      />,
    );
    await flushAsyncEffects();

    expect(vi.mocked(authenticatedFetch)).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Lazy");

    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    await flushAsyncEffects();

    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledWith(
      "/api/drive/objects/lazy-xls-1/preview",
    );
    expect(container.textContent).toContain("Visible");
  });

  it("bounds concurrent generated thumbnail fetches", async () => {
    const resolvers: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(authenticatedFetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          resolvers.push(() => {
            inFlight -= 1;
            resolve(
              new Response(
                `<!doctype html><main><div class="doc"><table><tbody><tr><td>Loaded</td></tr></tbody></table></div></main>`,
                { headers: { "content-type": "text/html" } },
              ),
            );
          });
        }),
    );

    render(
      <>
        {Array.from({ length: 8 }, (_, index) => (
          <FileThumbnail
            key={index}
            objectId={`bounded-${String(index)}`}
            name={`bounded-${String(index)}.xls`}
            mimeType="application/vnd.ms-excel"
            preview={{
              kind: "office",
              status: "unsupported",
              mimeType: "application/vnd.ms-excel",
            }}
            fallback={<span>{`Fallback ${String(index)}`}</span>}
          />
        ))}
      </>,
    );
    await flushAsyncEffects();

    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledTimes(6);
    expect(maxInFlight).toBeLessThanOrEqual(6);

    await act(async () => {
      resolvers.shift()?.();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledTimes(7);
    expect(maxInFlight).toBeLessThanOrEqual(6);

    await act(async () => {
      while (resolvers.length > 0) {
        resolvers.shift()?.();
      }
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledTimes(8);
    expect(maxInFlight).toBeLessThanOrEqual(6);
  });

  it("renders raw PDF thumbnails through PDF.js without embedding the PDF", async () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as unknown as
      typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,pdf");
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(new Uint8Array([4, 5, 6]).buffer),
    );
    pdfJsMock.getPage.mockResolvedValue({
      getViewport: ({ scale }: { readonly scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: pdfJsMock.render,
    });
    pdfJsMock.render.mockReturnValue({ promise: Promise.resolve() });
    pdfJsMock.getDocument.mockReturnValue({
      promise: Promise.resolve({
        getPage: pdfJsMock.getPage,
        destroy: pdfJsMock.destroy,
      }),
    });

    render(
      <FileThumbnail
        objectId="pdf-1"
        name="report.pdf"
        mimeType="application/pdf"
        fallback={<span>PDF</span>}
      />,
    );
    await flushAsyncEffects();

    expect(container.querySelector("iframe")).toBeNull();
    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledWith(
      "/api/drive/objects/pdf-1/preview",
    );
    expect(pdfJsMock.getDocument).toHaveBeenCalledWith({
      data: new Uint8Array([4, 5, 6]),
      verbosity: 0,
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,pdf");
  });

  async function flushAsyncEffects() {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("renders PDF and Office previews through a PDF.js first-page image", async () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as unknown as
      typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,preview");
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]).buffer),
    );
    pdfJsMock.getPage.mockResolvedValue({
      getViewport: ({ scale }: { readonly scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: pdfJsMock.render,
    });
    pdfJsMock.render.mockReturnValue({ promise: Promise.resolve() });
    pdfJsMock.getDocument.mockReturnValue({
      promise: Promise.resolve({
        getPage: pdfJsMock.getPage,
        destroy: pdfJsMock.destroy,
      }),
    });

    render(
      <FileThumbnail
        objectId="deck-1"
        name="deck.pptx"
        preview={{
          kind: "pdf",
          status: "available",
          mimeType: "application/pdf",
          url: "https://cdn.example/deck-preview.pdf",
        }}
      />,
    );
    await flushAsyncEffects();

    expect(container.querySelector("iframe")).toBeNull();
    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledWith(
      "https://cdn.example/deck-preview.pdf",
    );
    expect(pdfJsMock.getPage).toHaveBeenCalledWith(1);
    expect(pdfJsMock.GlobalWorkerOptions.workerSrc).toBe("/pdf.worker.mock.mjs");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,preview",
    );
  });

  it("uses the Drive preview endpoint when a PDF preview artifact has no public URL", async () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as unknown as
      typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,office-pdf");
    vi.mocked(authenticatedFetch).mockResolvedValue(
      new Response(new Uint8Array([7, 8, 9]).buffer),
    );
    pdfJsMock.getPage.mockResolvedValue({
      getViewport: ({ scale }: { readonly scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: pdfJsMock.render,
    });
    pdfJsMock.render.mockReturnValue({ promise: Promise.resolve() });
    pdfJsMock.getDocument.mockReturnValue({
      promise: Promise.resolve({
        getPage: pdfJsMock.getPage,
        destroy: pdfJsMock.destroy,
      }),
    });

    render(
      <FileThumbnail
        objectId="deck-pdf-preview"
        name="deck.pptx"
        preview={{
          kind: "pdf",
          status: "available",
          mimeType: "application/pdf",
          storageKey: "drive-previews/org/deck/v1/preview.pdf",
        }}
      />,
    );
    await flushAsyncEffects();

    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledWith(
      "/api/drive/objects/deck-pdf-preview/preview",
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,office-pdf",
    );
  });

  it("renders text previews without using the placeholder", () => {
    render(
      <FileThumbnail
        objectId="notes-1"
        name="notes.txt"
        preview={{
          kind: "text",
          status: "available",
          mimeType: "text/plain",
          text: "First line\nSecond line",
        }}
        fallback={<span>Fallback</span>}
      />,
    );

    expect(container.querySelector("pre")?.textContent).toContain("First line");
    expect(container.textContent).not.toContain("Fallback");
  });

  it("renders native Helix document text previews as mini documents", () => {
    render(
      <FileThumbnail
        objectId="doc-native-1"
        name="Launch plan"
        preview={{
          kind: "text",
          status: "available",
          mimeType: "application/vnd.helix.document",
          text: "Launch plan\nFirst milestone\nSecond milestone",
        }}
        fallback={<span>Fallback</span>}
      />,
    );

    expect(container.querySelector('[aria-label="Rendered preview of Launch plan"]')).not.toBeNull();
    expect(container.textContent).toContain("First milestone");
    expect(container.textContent).not.toContain("Fallback");
  });

  it("renders native Helix spreadsheet text previews as mini tables", () => {
    render(
      <FileThumbnail
        objectId="sheet-native-1"
        name="Forecast"
        preview={{
          kind: "text",
          status: "available",
          mimeType: "application/vnd.helix.spreadsheet",
          text: "Revenue\tOwner\n120000\tAvery",
        }}
        fallback={<span>Fallback</span>}
      />,
    );

    expect(container.querySelector("table")?.textContent).toContain("Revenue");
    expect(container.querySelector("table")?.textContent).toContain("Avery");
    expect(container.textContent).not.toContain("Fallback");
  });

  it("renders native Helix presentation text previews as mini slides", () => {
    render(
      <FileThumbnail
        objectId="slides-native-1"
        name="Board deck"
        preview={{
          kind: "text",
          status: "available",
          mimeType: "application/vnd.helix.presentation",
          text: "Board deck\nQ2 strategy\nCustomer proof",
        }}
        fallback={<span>Fallback</span>}
      />,
    );

    expect(container.querySelector('[aria-label="Rendered preview of Board deck"]')).not.toBeNull();
    expect(container.textContent).toContain("Customer proof");
    expect(container.textContent).not.toContain("Fallback");
  });
});
