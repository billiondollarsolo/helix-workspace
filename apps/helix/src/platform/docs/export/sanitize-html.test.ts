import { describe, expect, it } from "vitest";
import { exportDocsDocumentWithProviders } from "./formats.js";
import { sanitizeHtmlForExport } from "./sanitize-html.js";

describe("sanitizeHtmlForExport", () => {
  it("removes executable elements and their contents", () => {
    const output = sanitizeHtmlForExport(`
      <script src="http://evil.example/x">fetch("http://evil")</script>
      <iframe src="http://internal-service:5432/"></iframe>
      <object data="http://internal-service:5432/"></object>
      <embed src="http://internal-service:5432/" />
      <link rel="stylesheet" href="http://evil.example/x.css" />
      <base href="http://evil.example/" />
      <svg><image href="http://internal-service:5432/" /></svg>
      <math><mtext>x</mtext></math>
      <portal src="http://evil.example/" />
      <p>kept</p>
    `);

    expect(output).not.toMatch(/script|iframe|object|embed|link|base|svg|math|portal/iu);
    expect(output).not.toContain("internal-service");
    expect(output).not.toContain("evil.example");
    expect(output).toContain("<p>kept</p>");
  });

  it("removes active URL schemes and event handlers", () => {
    const output = sanitizeHtmlForExport(
      [
        '<a href="javascript:alert(1)">x1</a>',
        '<a href="data:text/html,x">x2</a>',
        '<a href="vbscript:msgbox(1)">x3</a>',
        '<a href="file:///etc/passwd">x4</a>',
        '<a href="ftp://evil/x">x5</a>',
        '<p onclick="fetch(1)" onload="x()">Body</p>',
        '<iframe srcdoc="x"></iframe>',
        '<a xlink:href="http://evil/">x6</a>',
      ].join(""),
    );

    expect(output).not.toMatch(/javascript:|data:|vbscript:|file:|ftp:|on\w+=|srcdoc|xlink/iu);
    expect(output).toContain("<p>Body</p>");
  });

  it("drops image sources but keeps benign document markup", () => {
    const output = sanitizeHtmlForExport(
      '<h1>Title</h1><p>Body with <strong>bold</strong>, <em>italic</em>, and <a href="#part">link</a>.</p><img src="http://internal/" alt="x"><ul><li>One</li></ul>',
    );

    expect(output).not.toContain("http://internal");
    expect(output).toContain("<h1>Title</h1>");
    expect(output).toContain("<strong>bold</strong>");
    expect(output).toContain('<a href="#part">link</a>');
    expect(output).toContain('<img alt="x"/>');
  });

  it("preserves export CSS without resurrecting removed script content", () => {
    const output = sanitizeHtmlForExport(
      '<style>@page { size: A4; } body { color: #111; }</style><script>fetch("http://evil")</script>',
    );
    expect(output).toContain("@page");
    expect(output).not.toContain("fetch(");
  });
});

describe("isolated PDF export boundary", () => {
  const document = {
    id: "33333333-3333-4333-8333-333333333333",
    orgId: "org-1",
    title: "Doc",
    markdown: "## Hello\nBody.",
    outline: [],
    comments: [],
  };

  it("sends only sanitized HTML to the configured renderer", async () => {
    let renderedHtml = "";
    await exportDocsDocumentWithProviders(
      {
        document: {
          ...document,
          html: [
            '<script src="http://evil.example/x"></script>',
            '<img src="http://internal-service:5432/">',
            '<p onclick="fetch(1)">Body</p>',
            '<iframe src="http://localhost/admin"></iframe>',
            '<a href="javascript:alert(1)">click</a>',
            "<h1>Real Title</h1>",
          ].join(""),
        },
        format: "pdf",
      },
      {
        pdfRenderer: {
          async render(input) {
            renderedHtml = input.html;
            return { buffer: Buffer.from("%PDF-1.7\n") };
          },
        },
      },
    );

    expect(renderedHtml).not.toMatch(
      /evil|internal-service|localhost|javascript:|<script|<iframe|onclick/iu,
    );
    expect(renderedHtml).toContain("<h1>Real Title</h1>");
  });

  it("fails closed when the isolated renderer is unavailable", async () => {
    await expect(
      exportDocsDocumentWithProviders(
        { document, format: "pdf" },
        {
          pdfRenderer: {
            async render() {
              throw new Error("converter unavailable");
            },
          },
        },
      ),
    ).rejects.toThrow("converter unavailable");
  });
});
