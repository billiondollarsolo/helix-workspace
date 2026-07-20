import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  assertPreviewUrlAllowed,
  createLibreOfficePreviewClient,
  createLocalOfficePreviewConverter,
  officePreviewStorageKey,
  type OfficePreviewConversionResult,
} from "./preview.js";
import { DriveForbiddenError } from "./errors.js";

describe("assertPreviewUrlAllowed", () => {
  it("rejects a link-local metadata host", () => {
    expect(() =>
      assertPreviewUrlAllowed("http://169.254.169.254/latest/meta-data", ["office.internal"]),
    ).toThrow(DriveForbiddenError);
  });

  it("permits an allowlisted office host", () => {
    expect(() =>
      assertPreviewUrlAllowed("http://office.internal:8080/convert", ["office.internal"]),
    ).not.toThrow();
  });

  it("rejects a non-allowlisted host when allowlist is non-empty", () => {
    expect(() =>
      assertPreviewUrlAllowed("http://evil.example/convert", ["office.internal"]),
    ).toThrow(/not allowlisted/i);
  });
});

describe("LibreOffice Drive preview client", () => {
  it("posts Office bytes and parses the converted PDF response", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const client = createLibreOfficePreviewClient({
      endpoint: "http://preview.example:8080",
      now: () => new Date("2026-05-20T12:00:00.000Z"),
      fetch: async (url, init) => {
        requests.push({ url: requestUrl(url), init: init ?? {} });
        return Response.json({
          pdfBase64: Buffer.from("%PDF-1.7\n").toString("base64"),
          pageCount: 2,
          generatedAt: "2026-05-20T12:00:01.000Z",
        });
      },
    });

    const result = await client.convert({
      objectId: "object-1",
      name: "Q3 deck.pptx",
      storageKey: "drive/org/object/v1/Q3_deck.pptx",
      sourceMimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      content: new TextEncoder().encode("pptx bytes"),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "http://preview.example:8080/convert/office-to-pdf",
      init: { method: "POST" },
    });
    expect(requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(requests[0]?.init.body as string)).toMatchObject({
      name: "Q3 deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      contentBase64: Buffer.from("pptx bytes").toString("base64"),
    });
    expect(new TextDecoder().decode(result.pdf)).toBe("%PDF-1.7\n");
    expect(result).toMatchObject({
      pageCount: 2,
      generatedAt: "2026-05-20T12:00:01.000Z",
    });
  });

  it("creates version-scoped preview storage keys", () => {
    expect(officePreviewStorageKey("org-1", "object-1", 3)).toMatch(
      /^drive-previews\/org-1\/object-1\/v3\/[0-9a-f-]+\.pdf$/,
    );
  });
});

describe("local Office Drive preview converter", () => {
  it("renders spreadsheet content to HTML before storing a PDF artifact", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Customer", "ARR"],
        ["Acme", 1200],
      ]),
      "Pipeline",
    );
    const content = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const rendered: string[] = [];
    const converter = createLocalOfficePreviewConverter({
      now: () => new Date("2026-05-28T09:00:00.000Z"),
      renderPdf: async ({ html }) => {
        rendered.push(html);
        return new TextEncoder().encode("%PDF-local\n");
      },
    });

    const result = await converter.convert({
      objectId: "object-1",
      name: "pipeline.xlsx",
      storageKey: "drive/org/object/v1/pipeline.xlsx",
      sourceMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      content,
    });

    expect(new TextDecoder().decode(result.pdf)).toBe("%PDF-local\n");
    expect(result.generatedAt).toBe("2026-05-28T09:00:00.000Z");
    expect(rendered[0]).toContain("Pipeline");
    expect(rendered[0]).toContain("Customer");
    expect(rendered[0]).toContain("Acme");
    expect(rendered[0]).toContain("1200");
  });

  it("renders real corpus DOCX content before creating the PDF artifact", async () => {
    const { html, result } = await convertCapturingHtml({
      name: "testWORD.docx",
      sourceMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      content: readCorpus("apache-tika/microsoft/testWORD.docx"),
    });

    expect(new TextDecoder().decode(result.pdf)).toBe("%PDF-local\n");
    expect(html).toContain("Sample Word Document Title");
    expect(html).toContain("This is a sample Microsoft Word Document.");
    expect(html).toContain("Helix Drive preview");
  });

  it("renders real corpus PPTX slide text before creating the PDF artifact", async () => {
    const { html } = await convertCapturingHtml({
      name: "testPPT.pptx",
      sourceMimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      content: readCorpus("apache-tika/microsoft/testPPT.pptx"),
    });

    expect(html).toContain("Slide 1");
    expect(html).toContain("Attachment Test");
    expect(html).toContain("Rajiv");
    expect(html).toContain("Different words to test against");
  });

  it("renders real corpus ODS and XLSB workbook previews with sanitized sheet names", async () => {
    const ods = await convertCapturingHtml({
      name: "LibreOfficeCalc_ods_1.3.ods",
      sourceMimeType: "application/vnd.oasis.opendocument.spreadsheet",
      content: readCorpus("apache-tika/miscoffice/versions/LibreOfficeCalc_ods_1.3.ods"),
    });
    const xlsb = await convertCapturingHtml({
      name: "testEXCEL.xlsb",
      sourceMimeType: "application/vnd.ms-excel.sheet.binary.macroenabled.12",
      content: readCorpus("apache-tika/microsoft/testEXCEL.xlsb"),
    });

    expect(ods.html).toContain("Sheet1");
    expect(visibleText(ods.html)).toContain("This is an example spreadsheet");
    expect(xlsb.html).toContain("Sheet 1");
    expect(xlsb.html).toContain(
      "This is an example spreadsheet created with Microsoft Excel 2007 Beta 2.",
    );
    expect(xlsb.html).not.toContain("rId1");
    expect(hasPreviewControlCharacter(xlsb.html)).toBe(false);
  });

  it("keeps unsupported legacy binary Office formats honest", async () => {
    let rendered = false;
    const converter = createLocalOfficePreviewConverter({
      renderPdf: async () => {
        rendered = true;
        return new TextEncoder().encode("%PDF-local\n");
      },
    });

    await expect(
      converter.convert({
        objectId: "object-1",
        name: "legacy.doc",
        storageKey: "drive/org/object/v1/legacy.doc",
        sourceMimeType: "application/msword",
        content: new TextEncoder().encode("binary doc bytes"),
      }),
    ).rejects.toThrow("Local Office preview conversion does not support legacy.doc");
    expect(rendered).toBe(false);
  });
});

async function convertCapturingHtml(input: {
  readonly name: string;
  readonly sourceMimeType: string;
  readonly content: Uint8Array;
}): Promise<{ readonly html: string; readonly result: OfficePreviewConversionResult }> {
  let html = "";
  const converter = createLocalOfficePreviewConverter({
    now: () => new Date("2026-05-28T09:00:00.000Z"),
    renderPdf: async ({ html: renderedHtml }) => {
      html = renderedHtml;
      return new TextEncoder().encode("%PDF-local\n");
    },
  });
  const result = await converter.convert({
    objectId: "object-1",
    name: input.name,
    storageKey: `drive/org/object/v1/${input.name}`,
    sourceMimeType: input.sourceMimeType,
    content: input.content,
  });
  return { html, result };
}

function readCorpus(path: string): Buffer {
  return readFileSync(`../../test-corpus/${path}`);
}

function visibleText(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/u, "").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
}

function hasPreviewControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (
      code >= 0x7f && code <= 0x9f
    )) {
      return true;
    }
  }
  return false;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}
