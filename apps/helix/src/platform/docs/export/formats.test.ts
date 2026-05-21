import { describe, expect, it } from "vitest";
import { docsExportFormatDescriptors } from "../types.js";
import { defaultExportFilename, exportDocsDocument } from "./formats.js";

const document = {
  id: "33333333-3333-4333-8333-333333333333",
  orgId: "org-1",
  title: "Launch Plan",
  markdown:
    "## Goals\nShip PDF, DOCX, and Markdown exports.\n\nReview [evidence](https://example.com).",
  comments: [
    {
      id: "comment-1",
      body: "Confirm binary downloads before release.",
      author: { id: "actor-1", displayName: "Ada Lovelace" },
      createdAt: "2026-05-20T12:00:00.000Z",
    },
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
    expect(packageText).toContain("<w:t>Launch Plan</w:t>");
    expect(packageText).toContain("<w:t>Ship PDF, DOCX, and Markdown exports.</w:t>");
    expect(packageText).toContain(
      "<w:t>Ada Lovelace: Confirm binary downloads before release.</w:t>",
    );
    expect(first.byteSize).toBe(docx.byteLength);
  });

  it("normalizes default filenames for every typed export format", () => {
    expect(defaultExportFilename("  Quarterly Review!  ", "markdown")).toBe(
      "quarterly-review.markdown",
    );
    expect(defaultExportFilename("Quarterly Review", "pdf")).toBe("quarterly-review.pdf");
    expect(defaultExportFilename("Quarterly Review", "docx")).toBe("quarterly-review.docx");
  });
});
