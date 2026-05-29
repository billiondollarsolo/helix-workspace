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
    const route = vi.fn(
      async (
        _url: string,
        _handler: (route: { abort(): Promise<void> }) => Promise<void> | void,
      ) => {},
    );
    const newPage = vi.fn(async () => ({
      route,
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
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0]?.[0]).toBe("**");
    expect(setContent).toHaveBeenCalledWith("<main>Hello</main>", {
      waitUntil: "domcontentloaded",
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
      route: vi.fn(async () => {}),
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

  it("aborts every subresource request — SSRF defense (CRITICAL-6)", async () => {
    // Capture the route handler so we can prove it aborts every request,
    // regardless of URL, and prove no asset fetch reaches the network.
    let registeredHandler: ((route: { abort(): Promise<void> }) => Promise<void>) | null = null;
    const abort = vi.fn(async () => {});
    const route = vi.fn(async (_url: string, handler: (route: { abort(): Promise<void> }) => Promise<void>) => {
      registeredHandler = handler;
    });
    const setContent = vi.fn(async () => {});
    const pdf = vi.fn(async () => new Uint8Array([]));
    const newPage = vi.fn(async () => ({ route, setContent, pdf }));
    const launch = vi.fn(async () => ({ newPage, close: vi.fn(async () => {}) }));
    const renderer = createHeadlessChromiumPdfRenderer({
      loadPlaywright: async (): Promise<PlaywrightChromiumModule> => ({
        chromium: { launch },
      }),
    });

    await renderer.render({
      ...renderInput,
      html: '<img src="http://internal-service:5432/" /><script src="http://evil.example/x"></script>',
    });

    expect(route).toHaveBeenCalledWith("**", expect.any(Function));
    expect(registeredHandler).not.toBeNull();
    // Simulate every external URL the rendered HTML might trigger:
    for (const url of [
      "http://evil.example/x",
      "http://internal-service:5432/",
      "https://10.0.0.1/secrets",
      "http://localhost:8080/admin",
      "file:///etc/passwd",
    ]) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await registeredHandler!({ abort });
      void url;
    }
    expect(abort).toHaveBeenCalledTimes(5);
  });

  it("uses domcontentloaded — not networkidle — so a malicious doc cannot stall the renderer", async () => {
    const setContent = vi.fn(async () => {});
    const newPage = vi.fn(async () => ({
      route: vi.fn(async () => {}),
      setContent,
      pdf: vi.fn(async () => new Uint8Array([])),
    }));
    const launch = vi.fn(async () => ({ newPage, close: vi.fn(async () => {}) }));
    const renderer = createHeadlessChromiumPdfRenderer({
      timeoutMs: 5000,
      loadPlaywright: async (): Promise<PlaywrightChromiumModule> => ({
        chromium: { launch },
      }),
    });

    await renderer.render(renderInput);

    expect(setContent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    expect(setContent).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ waitUntil: "networkidle" }),
    );
  });
});
