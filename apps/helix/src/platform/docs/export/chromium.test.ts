import { describe, expect, it, vi } from "vitest";
import {
  createHeadlessChromiumPdfRenderer,
  type PlaywrightChromiumModule,
} from "./chromium.js";

describe("createHeadlessChromiumPdfRenderer", () => {
  const renderInput = {
    document: {
      id: "doc_1",
      title: "Doc",
      blocks: [],
      updatedAt: "2026-05-25T00:00:00.000Z",
    },
    title: "Doc",
    markdown: "Hello",
    plainText: "Hello",
    html: "<main>Hello</main>",
    includeComments: false,
  };

  it("renders HTML through headless Chromium and closes the browser", async () => {
    const close = vi.fn(async () => {});
    const pdf = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const setContent = vi.fn(async () => {});
    const newPage = vi.fn(async () => ({
      setContent,
      pdf,
    }));
    const launch = vi.fn(async () => ({
      newPage,
      close,
    }));
    const renderer = createHeadlessChromiumPdfRenderer({
      executablePath: "/opt/chromium",
      timeoutMs: 1234,
      loadPlaywright: async (): Promise<PlaywrightChromiumModule> => ({
        chromium: { launch },
      }),
    });

    const result = await renderer.render(renderInput);

    expect(launch).toHaveBeenCalledWith({ headless: true, executablePath: "/opt/chromium" });
    expect(newPage).toHaveBeenCalledWith({
      viewport: { width: 816, height: 1056 },
      deviceScaleFactor: 1,
    });
    expect(setContent).toHaveBeenCalledWith("<main>Hello</main>", {
      waitUntil: "networkidle",
      timeout: 1234,
    });
    expect(pdf).toHaveBeenCalledWith({
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: "0.75in",
        right: "0.75in",
        bottom: "0.75in",
        left: "0.75in",
      },
      timeout: 1234,
    });
    expect(result.buffer).toEqual(Buffer.from([1, 2, 3]));
    expect(result.metadata).toEqual({ renderEngine: "playwright" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the browser when PDF rendering fails", async () => {
    const close = vi.fn(async () => {});
    const newPage = vi.fn(async () => ({
      setContent: vi.fn(async () => {}),
      pdf: vi.fn(async () => {
        throw new Error("pdf failed");
      }),
    }));
    const launch = vi.fn(async () => ({
      newPage,
      close,
    }));
    const renderer = createHeadlessChromiumPdfRenderer({
      loadPlaywright: async (): Promise<PlaywrightChromiumModule> => ({
        chromium: { launch },
      }),
    });

    await expect(
      renderer.render({
        ...renderInput,
        html: "<p>broken</p>",
      }),
    ).rejects.toThrow("pdf failed");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
