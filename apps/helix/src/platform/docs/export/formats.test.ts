import { describe, expect, it } from "vitest";
import { docsExportFormatDescriptors } from "../types.js";
import {
  defaultExportFilename,
  exportDocsDocument,
  exportDocsDocumentWithProviders,
} from "./formats.js";

const document = {
  id: "33333333-3333-4333-8333-333333333333",
  orgId: "org-1",
  title: "Launch Plan",
  markdown:
    "## Goals\nShip PDF, DOCX, and Markdown exports.\n\nReview [evidence](https://example.com).",
  outline: [{ id: "goals", level: 2, title: "Goals", anchor: "goals" }],
  comments: [
    {
      id: "comment-1",
      body: "Confirm binary downloads before release.",
      anchor: {
        kind: "native-document",
        target: "selection",
        documentId: "33333333-3333-4333-8333-333333333333",
        formatVersion: 1,
        quote: "Ship PDF, DOCX, and Markdown exports.",
        selection: {
          from: 10,
          to: 47,
          text: "Ship PDF, DOCX, and Markdown exports.",
        },
      },
      author: { id: "actor-1", displayName: "Ada Lovelace" },
      createdAt: "2026-05-20T12:00:00.000Z",
    },
  ],
};

const nativeTokenDocument = {
  ...document,
  title: '{{PROPERTY title="Native Tokens"}}',
  markdown: [
    "## Advanced fields",
    "Prepared {{DATE 2026-05-24}} at {{TIME 15:45 UTC}}.",
    'By {{AUTHOR Ada Lovelace}} for {{PROPERTY title="Roadmap draft"}}.',
    '{{EQUATION latex="E=mc^2"}}',
    '{{BOOKMARK launch-checklist "Launch checklist"}}',
    'See {{REF heading-2 "Launch goals"}} on page {{PAGE}}.',
    'Owner {{CHIP person label="Ada Lovelace" id="actor-1"}} shared {{CHIP doc label="Roadmap draft" id="doc-1"}}.',
  ].join("\n"),
  html: '<h1>{{PROPERTY title="Roadmap draft"}}</h1><p>{{EQUATION latex="E=mc^2"}}</p>',
  outline: [
    { id: "advanced-fields", level: 2, title: "Advanced fields", anchor: "advanced-fields" },
  ],
};

describe("docs export formats", () => {
  it("exports Markdown with typed format metadata and optional comments", () => {
    const exported = exportDocsDocument({
      document,
      format: "markdown",
      includeComments: true,
    });

    expect(exported).toMatchObject({
      docId: document.id,
      format: "markdown",
      filename: "launch-plan.markdown",
      mimeType: docsExportFormatDescriptors.markdown.mimeType,
      metadata: { generatedBy: "helix.docs.export.markdown" },
    });
    expect(exported.text).toContain("## Comments");
    expect(Buffer.from(exported.contentBase64, "base64").toString("utf8")).toBe(exported.text);
    expect(exported.text).toContain("Ada Lovelace: Confirm binary downloads before release.");
  });

  it("exports deterministic minimal valid PDF bytes", () => {
    const first = exportDocsDocument({ document, format: "pdf", includeComments: true });
    const second = exportDocsDocument({ document, format: "pdf", includeComments: true });
    const pdf = Buffer.from(first.contentBase64, "base64").toString("utf8");
    const startxrefMatch = /startxref\n(\d+)\n%%EOF/u.exec(pdf);
    const startxref = startxrefMatch?.[1];

    expect(first).toMatchObject({
      filename: "launch-plan.pdf",
      mimeType: docsExportFormatDescriptors.pdf.mimeType,
      metadata: { generatedBy: "helix.docs.export.pdf", deterministic: true },
    });
    expect(first.contentBase64).toBe(second.contentBase64);
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf).toContain("xref\n0 6");
    expect(pdf).toContain("trailer\n<< /Size 6 /Root 1 0 R >>");
    expect(startxref).toBeDefined();
    expect(pdf.slice(Number(startxref), Number(startxref) + 4)).toBe("xref");
    expect(first.byteSize).toBe(Buffer.byteLength(pdf, "utf8"));
  });

  it("exports PDF bytes through a headless Chromium renderer provider", async () => {
    const renderedPdf = Buffer.from("%PDF-1.7\n% chromium render\n", "utf8");
    const exported = await exportDocsDocumentWithProviders(
      { document, format: "pdf", includeComments: true },
      {
        pdfRenderer: {
          async render(input) {
            expect(input.title).toBe("Launch Plan");
            expect(input.markdown).toContain("## Comments");
            expect(input.plainText).toContain("Ada Lovelace");
            expect(input.html).toContain("<h1>Launch Plan</h1>");
            return {
              buffer: renderedPdf,
              metadata: { chromiumRevision: "test-revision" },
            };
          },
        },
      },
    );

    expect(exported).toMatchObject({
      filename: "launch-plan.pdf",
      mimeType: docsExportFormatDescriptors.pdf.mimeType,
      byteSize: renderedPdf.byteLength,
      contentBase64: renderedPdf.toString("base64"),
      metadata: {
        generatedBy: "helix.docs.export.pdf.chromium",
        renderer: "headless-chromium",
        chromiumRevision: "test-revision",
      },
    });
  });

  it("renders native document tokens as readable export text", async () => {
    const markdownExport = exportDocsDocument({
      document: nativeTokenDocument,
      format: "markdown",
    });
    const markdown = markdownExport.text ?? "";

    expect(markdown).toContain("# Native Tokens");
    expect(markdown).toContain("Prepared 2026-05-24 at 15:45 UTC.");
    expect(markdown).toContain("By Ada Lovelace for Roadmap draft.");
    expect(markdown).toContain("Equation: E=mc^2");
    expect(markdown).toContain("See [Launch goals](#heading-2) on page 1.");
    expect(markdown).toContain("Owner Ada Lovelace shared Roadmap draft.");
    expect(markdown).not.toContain("{{");

    const docxExport = exportDocsDocument({ document: nativeTokenDocument, format: "docx" });
    const docx = Buffer.from(docxExport.contentBase64, "base64").toString("utf8");
    expect(docx).toContain("<w:t>Equation: E=mc^2</w:t>");
    expect(docx).toContain("<w:t>See Launch goals on page 1.</w:t>");
    expect(docx).toContain("<w:t>Owner Ada Lovelace shared Roadmap draft.</w:t>");
    expect(docx).not.toContain("{{");

    const epubExport = exportDocsDocument({ document: nativeTokenDocument, format: "epub" });
    const epub = Buffer.from(epubExport.contentBase64, "base64").toString("utf8");
    expect(epub).toContain("<p>Equation: E=mc^2</p>");
    expect(epub).toContain('<p>See <a href="#heading-2">Launch goals</a> on page 1.</p>');
    expect(epub).toContain("<p>Owner Ada Lovelace shared Roadmap draft.</p>");
    expect(epub).not.toContain("[Launch goals](#heading-2)");
    expect(epub).not.toContain("{{");

    await exportDocsDocumentWithProviders(
      { document: nativeTokenDocument, format: "pdf" },
      {
        pdfRenderer: {
          async render(input) {
            expect(input.title).toBe("Native Tokens");
            expect(input.markdown).toContain("Equation: E=mc^2");
            expect(input.markdown).toContain("See [Launch goals](#heading-2) on page 1.");
            expect(input.plainText).toContain("See Launch goals on page 1.");
            expect(input.plainText).toContain("Owner Ada Lovelace shared Roadmap draft.");
            expect(input.html).toContain("<h1>Roadmap draft</h1>");
            expect(input.html).toContain("<p>Equation: E=mc^2</p>");
            expect(input.html).toContain(
              '<p>See <a href="#heading-2">Launch goals</a> on page 1.</p>',
            );
            expect(input.markdown).not.toContain("{{");
            expect(input.html).not.toContain("{{");
            return { buffer: Buffer.from("%PDF-1.7\n% token render\n", "utf8") };
          },
        },
      },
    );
  });

  it("exports generated table-of-contents references as internal Markdown and EPUB links", () => {
    const tocDocument = {
      ...document,
      title: "TOC Export",
      markdown: [
        "Table of contents",
        "",
        '- {{REF goals "Goals"}}',
        '  - {{REF risks-and-mitigations "Risks and mitigations"}}',
        "",
        "## Goals",
        "Ship the editor exports.",
        "",
        "### Risks and mitigations",
        "Track gaps before release.",
      ].join("\n"),
      outline: [
        { id: "goals", level: 2, title: "Goals", anchor: "goals" },
        {
          id: "risks-and-mitigations",
          level: 3,
          title: "Risks and mitigations",
          anchor: "risks-and-mitigations",
        },
      ],
    };

    const markdownExport = exportDocsDocument({ document: tocDocument, format: "markdown" });
    expect(markdownExport.text).toContain("- [Goals](#goals)");
    expect(markdownExport.text).toContain("  - [Risks and mitigations](#risks-and-mitigations)");

    const epubExport = exportDocsDocument({ document: tocDocument, format: "epub" });
    const epub = Buffer.from(epubExport.contentBase64, "base64").toString("utf8");
    expect(epub).toContain('<p class="list-item"><a href="#goals">Goals</a></p>');
    expect(epub).toContain(
      '<p class="list-item"><a href="#risks-and-mitigations">Risks and mitigations</a></p>',
    );
    expect(epub).toContain('<h2 id="goals">Goals</h2>');
    expect(epub).toContain('<h3 id="risks-and-mitigations">Risks and mitigations</h3>');
    expect(epub).not.toContain("[Goals](#goals)");
  });

  it("carries native document layout metadata into export containers", async () => {
    const layoutDocument = {
      ...document,
      title: "Layout Export",
      markdown: "## Layout\nColumn-aware export body.",
      metadata: {
        nativeDocumentLayout: {
          layoutMode: "pageless",
          columnCount: 1,
          sections: [
            {
              id: "default",
              title: "Document",
              layoutMode: "pageless",
              columnCount: 2,
              pageSize: "a4",
              orientation: "landscape",
            },
          ],
        },
      },
      comments: [],
    };

    await exportDocsDocumentWithProviders(
      { document: layoutDocument, format: "pdf" },
      {
        pdfRenderer: {
          async render(input) {
            expect(input.html).toContain('body class="layout-pageless columns-2"');
            expect(input.html).toContain("@page { size: A4 landscape;");
            expect(input.html).toContain(".document-body { max-width: none;");
            expect(input.html).toContain("column-count: 2;");
            expect(input.html).toContain('<main class="document-body">');
            return { buffer: Buffer.from("%PDF-1.7\n% layout render\n", "utf8") };
          },
        },
      },
    );

    const docxExport = exportDocsDocument({ document: layoutDocument, format: "docx" });
    const docx = Buffer.from(docxExport.contentBase64, "base64").toString("utf8");
    expect(docx).toContain('<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>');
    expect(docx).toContain('<w:cols w:num="2" w:space="720"/>');

    const epubExport = exportDocsDocument({ document: layoutDocument, format: "epub" });
    const epub = Buffer.from(epubExport.contentBase64, "base64").toString("utf8");
    expect(epub).toContain('<body class="layout-pageless page-a4 orientation-landscape">');
    expect(epub).toContain('<section class="document-body columns-2">');
    expect(epub).toContain("body.page-a4 .document-body { max-width: 210mm; }");
    expect(epub).toContain(".document-body.columns-2 { column-count: 2; column-gap: 2rem; }");
    expect(epub).toContain("Column-aware export body.");
  });

  it("falls back to deterministic PDF bytes when the Chromium renderer fails", async () => {
    const errors: unknown[] = [];
    const exported = await exportDocsDocumentWithProviders(
      { document, format: "pdf", includeComments: true },
      {
        pdfRenderer: {
          async render() {
            throw new Error("Chromium unavailable");
          },
        },
        onPdfRendererError: (error) => {
          errors.push(error);
        },
      },
    );
    const pdf = Buffer.from(exported.contentBase64, "base64").toString("utf8");

    expect(errors).toHaveLength(1);
    expect(exported.metadata).toEqual({
      generatedBy: "helix.docs.export.pdf",
      deterministic: true,
      fallback: true,
      fallbackFrom: "headless-chromium",
    });
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
  });

  it("exports deterministic minimal valid DOCX OpenXML package bytes", () => {
    const first = exportDocsDocument({ document, format: "docx", includeComments: true });
    const second = exportDocsDocument({ document, format: "docx", includeComments: true });
    const docx = Buffer.from(first.contentBase64, "base64");
    const packageText = docx.toString("utf8");

    expect(first).toMatchObject({
      filename: "launch-plan.docx",
      mimeType: docsExportFormatDescriptors.docx.mimeType,
      metadata: { generatedBy: "helix.docs.export.docx", deterministic: true },
    });
    expect(first.contentBase64).toBe(second.contentBase64);
    expect(docx.subarray(0, 4).toString("binary")).toBe("PK\u0003\u0004");
    expect(docx.readUInt32LE(docx.byteLength - 22)).toBe(0x06054b50);
    expect(packageText).toContain("[Content_Types].xml");
    expect(packageText).toContain("_rels/.rels");
    expect(packageText).toContain("word/document.xml");
    expect(packageText).toContain("word/_rels/document.xml.rels");
    expect(packageText).toContain("word/comments.xml");
    expect(packageText).toContain(
      'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"',
    );
    expect(packageText).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"',
    );
    expect(packageText).toContain("<w:t>Launch Plan</w:t>");
    expect(packageText).toContain("<w:t>Ship PDF, DOCX, and Markdown exports.</w:t>");
    expect(packageText).toContain('<w:commentRangeStart w:id="0"/>');
    expect(packageText).toContain('<w:commentRangeEnd w:id="0"/>');
    expect(packageText).toContain('<w:commentReference w:id="0"/>');
    const titleIndex = packageText.indexOf("<w:t>Launch Plan</w:t>");
    const anchorIndex = packageText.indexOf("<w:t>Ship PDF, DOCX, and Markdown exports.</w:t>");
    const commentRangeIndex = packageText.indexOf('<w:commentRangeStart w:id="0"/>');
    expect(commentRangeIndex).toBeGreaterThan(titleIndex);
    expect(commentRangeIndex).toBeLessThan(anchorIndex);
    expect(packageText).toContain('<w:comment w:id="0" w:author="Ada Lovelace"');
    expect(packageText).toContain("<w:t>Confirm binary downloads before release.</w:t>");
    expect(packageText).not.toContain("Ada Lovelace: Confirm binary downloads before release.");
    expect(first.byteSize).toBe(docx.byteLength);
  });

  it("falls back DOCX comments to the title when native selection anchors are stale", () => {
    const staleAnchorDocument = {
      ...document,
      comments: [
        {
          id: "comment-1",
          body: "Confirm binary downloads before release.",
          anchor: {
            kind: "native-document",
            target: "selection",
            documentId: document.id,
            formatVersion: 1,
            quote: "Text that no longer exists.",
            selection: {
              from: 500,
              to: 527,
              text: "Text that no longer exists.",
            },
          },
          author: { id: "actor-1", displayName: "Ada Lovelace" },
          createdAt: "2026-05-20T12:00:00.000Z",
        },
      ],
    };
    const exported = exportDocsDocument({
      document: staleAnchorDocument,
      format: "docx",
      includeComments: true,
    });
    const packageText = Buffer.from(exported.contentBase64, "base64").toString("utf8");

    const commentRangeIndex = packageText.indexOf('<w:commentRangeStart w:id="0"/>');
    const titleIndex = packageText.indexOf("<w:t>Launch Plan</w:t>");
    const bodyIndex = packageText.indexOf("<w:t>Ship PDF, DOCX, and Markdown exports.</w:t>");
    expect(commentRangeIndex).toBeLessThan(titleIndex);
    expect(titleIndex).toBeLessThan(bodyIndex);
  });

  it("exports simple Markdown pipe tables as DOCX tables without shifting later comment anchors", () => {
    const tableDocument = {
      ...document,
      markdown: [
        "Before table.",
        "",
        "| Status | Owner |",
        "| --- | :---: |",
        "| Ready | Ada |",
        "| Blocked | Grace |",
        "",
        "Follow-up paragraph remains commentable.",
      ].join("\n"),
      comments: [
        {
          id: "comment-1",
          body: "Review this follow-up.",
          anchor: {
            kind: "native-document",
            target: "selection",
            documentId: document.id,
            formatVersion: 1,
            quote: "Follow-up paragraph remains commentable.",
            selection: {
              from: 100,
              to: 138,
              text: "Follow-up paragraph remains commentable.",
            },
          },
          author: { id: "actor-1", displayName: "Ada Lovelace" },
          createdAt: "2026-05-20T12:00:00.000Z",
        },
      ],
    };
    const exported = exportDocsDocument({
      document: tableDocument,
      format: "docx",
      includeComments: true,
    });
    const packageText = Buffer.from(exported.contentBase64, "base64").toString("utf8");

    expect(packageText).toContain("<w:t>Before table.</w:t>");
    expect(packageText).toContain("<w:tbl>");
    expect(packageText).toContain("<w:tr>");
    expect(packageText).toContain("<w:tc>");
    expect(packageText).toContain("<w:t>Status</w:t>");
    expect(packageText).toContain("<w:t>Owner</w:t>");
    expect(packageText).toContain("<w:t>Ready</w:t>");
    expect(packageText).toContain("<w:t>Ada</w:t>");
    expect(packageText).toContain("<w:t>Follow-up paragraph remains commentable.</w:t>");
    expect(packageText).not.toContain("<w:t>---</w:t>");
    expect(packageText).not.toContain("<w:t>:---:</w:t>");

    const tableIndex = packageText.indexOf("<w:tbl>");
    const followUpIndex = packageText.indexOf(
      "<w:t>Follow-up paragraph remains commentable.</w:t>",
    );
    const commentRangeIndex = packageText.indexOf('<w:commentRangeStart w:id="0"/>');
    expect(tableIndex).toBeGreaterThan(packageText.indexOf("<w:t>Before table.</w:t>"));
    expect(followUpIndex).toBeGreaterThan(tableIndex);
    expect(commentRangeIndex).toBeGreaterThan(tableIndex);
    expect(commentRangeIndex).toBeLessThan(followUpIndex);
  });

  it("embeds base64 Markdown images as DOCX media parts", () => {
    const png1x1 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const imageDocument = {
      ...document,
      markdown: [
        "Before image.",
        "",
        `![Architecture diagram](data:image/png;base64,${png1x1})`,
        "",
        "After image.",
      ].join("\n"),
      comments: [],
    };
    const exported = exportDocsDocument({ document: imageDocument, format: "docx" });
    const docx = Buffer.from(exported.contentBase64, "base64");
    const packageText = docx.toString("utf8");

    expect(packageText).toContain("word/media/image1.png");
    expect(packageText).toContain('<Default Extension="png" ContentType="image/png"/>');
    expect(packageText).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"',
    );
    expect(packageText).toContain('Target="media/image1.png"');
    expect(packageText).toContain('<a:blip r:embed="rIdImage1"/>');
    expect(packageText).toContain('descr="Architecture diagram"');
    expect(packageText).toContain("<w:t>Before image.</w:t>");
    expect(packageText).toContain("<w:t>After image.</w:t>");
    expect(packageText).not.toContain("<w:t>Architecture diagram</w:t>");
    expect(docx.includes(Buffer.from(png1x1, "base64"))).toBe(true);
  });

  it("falls unsupported Markdown image URLs back to readable DOCX text", () => {
    const imageDocument = {
      ...document,
      markdown: [
        "Before image.",
        '![Remote diagram](https://example.com/diagram.png "Remote")',
        "After image.",
      ].join("\n"),
      comments: [],
    };
    const exported = exportDocsDocument({ document: imageDocument, format: "docx" });
    const packageText = Buffer.from(exported.contentBase64, "base64").toString("utf8");

    expect(packageText).not.toContain("word/media/");
    expect(packageText).not.toContain("relationships/image");
    expect(packageText).toContain("<w:t>Before image.</w:t>");
    expect(packageText).toContain("<w:t>Image: Remote diagram</w:t>");
    expect(packageText).toContain("<w:t>After image.</w:t>");
  });

  it("preserves basic Markdown heading and list styles in DOCX paragraphs", () => {
    const styledDocument = {
      ...document,
      markdown: [
        "## Styled section",
        "Opening paragraph.",
        "- Bullet action",
        "1. Ordered action",
        "Follow-up paragraph remains commentable.",
      ].join("\n"),
      comments: [
        {
          id: "comment-1",
          body: "Review the styled export.",
          anchor: {
            kind: "native-document",
            target: "selection",
            documentId: document.id,
            formatVersion: 1,
            quote: "Follow-up paragraph remains commentable.",
            selection: {
              from: 100,
              to: 138,
              text: "Follow-up paragraph remains commentable.",
            },
          },
          author: { id: "actor-1", displayName: "Ada Lovelace" },
          createdAt: "2026-05-20T12:00:00.000Z",
        },
      ],
    };
    const exported = exportDocsDocument({
      document: styledDocument,
      format: "docx",
      includeComments: true,
    });
    const packageText = Buffer.from(exported.contentBase64, "base64").toString("utf8");

    expect(packageText).toContain("word/styles.xml");
    expect(packageText).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"',
    );
    expect(packageText).toContain(
      'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"',
    );
    expect(packageText).toContain('<w:style w:type="paragraph" w:styleId="Heading2">');
    expect(packageText).toContain('<w:style w:type="paragraph" w:styleId="ListBullet">');
    expect(packageText).toContain('<w:style w:type="paragraph" w:styleId="ListNumber">');
    expect(packageText).toContain(
      '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Styled section</w:t></w:r></w:p>',
    );
    expect(packageText).toContain(
      '<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>Bullet action</w:t></w:r></w:p>',
    );
    expect(packageText).toContain(
      '<w:p><w:pPr><w:pStyle w:val="ListNumber"/></w:pPr><w:r><w:t>Ordered action</w:t></w:r></w:p>',
    );
    const followUpIndex = packageText.indexOf(
      "<w:t>Follow-up paragraph remains commentable.</w:t>",
    );
    const commentRangeIndex = packageText.indexOf('<w:commentRangeStart w:id="0"/>');
    expect(commentRangeIndex).toBeLessThan(followUpIndex);
  });

  it("preserves bounded inline Markdown styles in DOCX text runs", () => {
    const inlineStyledDocument = {
      ...document,
      markdown: [
        "Normal **bold** and *italic* text with `code`.",
        "Follow-up paragraph remains commentable.",
      ].join("\n"),
      comments: [
        {
          id: "comment-1",
          body: "Review the inline styles.",
          anchor: {
            kind: "native-document",
            target: "selection",
            documentId: document.id,
            formatVersion: 1,
            quote: "Follow-up paragraph remains commentable.",
            selection: {
              from: 100,
              to: 138,
              text: "Follow-up paragraph remains commentable.",
            },
          },
          author: { id: "actor-1", displayName: "Ada Lovelace" },
          createdAt: "2026-05-20T12:00:00.000Z",
        },
      ],
    };
    const exported = exportDocsDocument({
      document: inlineStyledDocument,
      format: "docx",
      includeComments: true,
    });
    const packageText = Buffer.from(exported.contentBase64, "base64").toString("utf8");

    expect(packageText).toContain('<w:t xml:space="preserve">Normal </w:t>');
    expect(packageText).toContain("<w:rPr><w:b/></w:rPr><w:t>bold</w:t>");
    expect(packageText).toContain("<w:rPr><w:i/></w:rPr><w:t>italic</w:t>");
    expect(packageText).toContain(
      '<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:shd w:fill="F3F4F6"/></w:rPr><w:t>code</w:t>',
    );
    expect(packageText).not.toContain("**bold**");
    expect(packageText).not.toContain("*italic*");
    expect(packageText).not.toContain("`code`");
    const followUpIndex = packageText.indexOf(
      "<w:t>Follow-up paragraph remains commentable.</w:t>",
    );
    const commentRangeIndex = packageText.indexOf('<w:commentRangeStart w:id="0"/>');
    expect(commentRangeIndex).toBeLessThan(followUpIndex);
  });

  it("exports inline Markdown links as DOCX external hyperlinks", () => {
    const linkedDocument = {
      ...document,
      markdown: [
        "Review [launch evidence](https://example.com/evidence?a=1&b=2) before release.",
        "Follow-up paragraph remains commentable.",
      ].join("\n"),
      comments: [
        {
          id: "comment-1",
          body: "Review the linked export.",
          anchor: {
            kind: "native-document",
            target: "selection",
            documentId: document.id,
            formatVersion: 1,
            quote: "Follow-up paragraph remains commentable.",
            selection: {
              from: 100,
              to: 138,
              text: "Follow-up paragraph remains commentable.",
            },
          },
          author: { id: "actor-1", displayName: "Ada Lovelace" },
          createdAt: "2026-05-20T12:00:00.000Z",
        },
      ],
    };
    const exported = exportDocsDocument({
      document: linkedDocument,
      format: "docx",
      includeComments: true,
    });
    const packageText = Buffer.from(exported.contentBase64, "base64").toString("utf8");

    expect(packageText).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"',
    );
    expect(packageText).toContain('Target="https://example.com/evidence?a=1&amp;b=2"');
    expect(packageText).toContain('TargetMode="External"');
    expect(packageText).toContain('<w:hyperlink r:id="rIdHyperlink1" w:history="1">');
    expect(packageText).toContain("<w:t>launch evidence</w:t>");
    expect(packageText).toContain('<w:color w:val="0563C1"/><w:u w:val="single"/>');
    expect(packageText).not.toContain("[launch evidence](");
    expect(packageText).not.toContain("(https://example.com/evidence?a=1&b=2)");
    const followUpIndex = packageText.indexOf(
      "<w:t>Follow-up paragraph remains commentable.</w:t>",
    );
    const commentRangeIndex = packageText.indexOf('<w:commentRangeStart w:id="0"/>');
    expect(commentRangeIndex).toBeLessThan(followUpIndex);
  });

  it("omits DOCX comment parts when comments are not requested", () => {
    const exported = exportDocsDocument({ document, format: "docx", includeComments: false });
    const packageText = Buffer.from(exported.contentBase64, "base64").toString("utf8");

    expect(packageText).toContain("word/document.xml");
    expect(packageText).not.toContain("word/comments.xml");
    expect(packageText).not.toContain("relationships/comments");
    expect(packageText).not.toContain("commentReference");
    expect(packageText).not.toContain("Confirm binary downloads before release.");
  });

  it("exports deterministic minimal valid EPUB package bytes with navigation", () => {
    const first = exportDocsDocument({ document, format: "epub", includeComments: true });
    const second = exportDocsDocument({ document, format: "epub", includeComments: true });
    const epub = Buffer.from(first.contentBase64, "base64");
    const packageText = epub.toString("utf8");

    expect(first).toMatchObject({
      filename: "launch-plan.epub",
      mimeType: docsExportFormatDescriptors.epub.mimeType,
      metadata: { generatedBy: "helix.docs.export.epub", deterministic: true },
    });
    expect(first.contentBase64).toBe(second.contentBase64);
    expect(epub.subarray(0, 4).toString("binary")).toBe("PK\u0003\u0004");
    expect(packageText).toContain("mimetypeapplication/epub+zip");
    expect(packageText).toContain("META-INF/container.xml");
    expect(packageText).toContain("OEBPS/content.opf");
    expect(packageText).toContain("OEBPS/nav.xhtml");
    expect(packageText).toContain("OEBPS/document.xhtml");
    expect(packageText).toContain("<dc:title>Launch Plan</dc:title>");
    expect(packageText).toContain('<a href="document.xhtml#goals">Goals</a>');
    expect(packageText).toContain('<h1 id="heading-1">Launch Plan</h1>');
    expect(packageText).toContain('<h2 id="goals">Goals</h2>');
    expect(first.byteSize).toBe(epub.byteLength);
  });

  it("normalizes default filenames for every typed export format", () => {
    expect(defaultExportFilename("  Quarterly Review!  ", "markdown")).toBe(
      "quarterly-review.markdown",
    );
    expect(defaultExportFilename("Quarterly Review", "pdf")).toBe("quarterly-review.pdf");
    expect(defaultExportFilename("Quarterly Review", "docx")).toBe("quarterly-review.docx");
    expect(defaultExportFilename("Quarterly Review", "epub")).toBe("quarterly-review.epub");
  });
});
