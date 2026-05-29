import type { PdfExportRenderer } from "./formats.js";

export interface HeadlessChromiumPdfRendererOptions {
  readonly executablePath?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly loadPlaywright?: (() => Promise<PlaywrightChromiumModule>) | undefined;
}

export interface PlaywrightChromiumModule {
  readonly chromium: {
    launch(options: { readonly headless: true; readonly executablePath?: string }): Promise<{
      newPage(options: {
        readonly viewport: { readonly width: number; readonly height: number };
        readonly deviceScaleFactor: number;
      }): Promise<{
        route(
          url: string,
          handler: (route: { abort(): Promise<void> }) => Promise<void> | void,
        ): Promise<unknown>;
        setContent(
          html: string,
          options: {
            readonly waitUntil: "domcontentloaded";
            readonly timeout: number;
          },
        ): Promise<void>;
        pdf(options: {
          readonly format: "Letter";
          readonly printBackground: true;
          readonly preferCSSPageSize: true;
          readonly margin: {
            readonly top: string;
            readonly right: string;
            readonly bottom: string;
            readonly left: string;
          };
          readonly timeout: number;
        }): Promise<Buffer | Uint8Array>;
      }>;
      close(): Promise<void>;
    }>;
  };
}

export function createHeadlessChromiumPdfRenderer(
  options: HeadlessChromiumPdfRendererOptions = {},
): PdfExportRenderer {
  return {
    async render(input) {
      const { chromium } = await (options.loadPlaywright ?? importPlaywright)();
      const browser = await chromium.launch({
        headless: true,
        ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
      });
      try {
        const page = await browser.newPage({
          viewport: { width: 816, height: 1056 },
          deviceScaleFactor: 1,
        });
        // SSRF defense (CRITICAL-6): unconditionally abort every subresource
        // request issued by the rendered HTML. Combined with the HTML
        // sanitizer in sanitize-html.ts, this prevents a malicious document
        // from causing Chromium to fetch arbitrary URLs from inside our
        // network perimeter. Do not add an allowlist — full block.
        await page.route("**", (route) => route.abort());
        await page.setContent(input.html, {
          // We control the HTML and have blocked all subresource fetches, so
          // we never need to wait for "networkidle" — DOM construction is
          // sufficient. Waiting for networkidle here would also let a doc
          // hold the export open until the per-request timeout.
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs ?? 15_000,
        });
        const pdf = await page.pdf({
          format: "Letter",
          printBackground: true,
          preferCSSPageSize: true,
          margin: {
            top: "0.75in",
            right: "0.75in",
            bottom: "0.75in",
            left: "0.75in",
          },
          timeout: options.timeoutMs ?? 15_000,
        });
        return {
          buffer: Buffer.from(pdf),
          metadata: { renderEngine: "playwright" },
        };
      } finally {
        await browser.close();
      }
    },
  };
}

async function importPlaywright(): Promise<PlaywrightChromiumModule> {
  return import("playwright");
}
