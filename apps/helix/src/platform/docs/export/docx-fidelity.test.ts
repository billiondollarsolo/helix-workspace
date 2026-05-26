import { describe, expect, it } from "vitest";
import { verifyDocxExportFidelity } from "./docx-fidelity.js";

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

describe("DOCX fidelity gate", () => {
  it("round-trips exported DOCX through Mammoth and verifies core content fragments", async () => {
    const report = await verifyDocxExportFidelity({
      document,
      includeComments: true,
    });

    expect(report.passed).toBe(true);
    expect(report.byteSize).toBeGreaterThan(0);
    expect(report.packageEntries).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "word/document.xml",
        "word/_rels/document.xml.rels",
        "word/comments.xml",
      ]),
    );
    expect(report.hasCommentsPart).toBe(true);
    expect(report.hasCommentsRelationship).toBe(true);
    expect(report.hasCommentsContentType).toBe(true);
    expect(report.checkedFragments).toBeGreaterThanOrEqual(4);
    expect(report.missingFragments).toEqual([]);
    expect(report.matchedFragments).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Launch Plan"),
        expect.stringContaining("Ship PDF, DOCX"),
      ]),
    );
    expect(report.extractedMarkdown).toContain("Launch Plan");
  });

  it("reports missing required fragments without throwing", async () => {
    const report = await verifyDocxExportFidelity({
      document,
      fragments: [
        { label: "title", text: "Launch Plan" },
        { label: "missing-footer", text: "Signed by the board" },
      ],
      converter: async () => ({
        markdown: "Launch Plan\n\nGoals\n\nShip PDF, DOCX, and Markdown exports.",
      }),
    });

    expect(report.passed).toBe(false);
    expect(report.matchedFragments).toEqual(["title"]);
    expect(report.missingFragments).toEqual(["missing-footer"]);
  });
});
