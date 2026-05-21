import type { JsonObject } from "@helix/sdk-types";
import {
  docsExportFormatDescriptors,
  type DocsExportDocument,
  type DocsExportFormat,
  type DocsExportResult,
} from "../types.js";

export interface ExportDocsDocumentInput {
  readonly document: DocsExportDocument;
  readonly format: DocsExportFormat;
  readonly includeComments?: boolean | undefined;
  readonly filename?: string | undefined;
}

export function exportDocsDocument(input: ExportDocsDocumentInput): DocsExportResult {
  const filename = input.filename ?? defaultExportFilename(input.document.title, input.format);
  const descriptor = docsExportFormatDescriptors[input.format];
  if (input.format === "markdown") {
    const markdown = renderMarkdown(input.document, input.includeComments === true);
    return resultFromBuffer({
      docId: input.document.id,
      format: input.format,
      filename,
      mimeType: descriptor.mimeType,
      buffer: Buffer.from(markdown, "utf8"),
      text: markdown,
      metadata: { generatedBy: "helix.docs.export.markdown" },
    });
  }

  if (input.format === "pdf") {
    const text = renderPlainText(input.document, input.includeComments === true);
    return resultFromBuffer({
      docId: input.document.id,
      format: input.format,
      filename,
      mimeType: descriptor.mimeType,
      buffer: renderPdfScaffold(input.document.title, text),
      metadata: { generatedBy: "helix.docs.export.pdf", deterministic: true },
    });
  }

  const markdown = renderMarkdown(input.document, input.includeComments === true);
  return resultFromBuffer({
    docId: input.document.id,
    format: input.format,
    filename,
    mimeType: descriptor.mimeType,
    buffer: renderDocxScaffold(input.document.title, markdown),
    metadata: { generatedBy: "helix.docs.export.docx", deterministic: true },
  });
}

export function defaultExportFilename(title: string, format: DocsExportFormat): string {
  const basename =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 80) || "untitled";
  return `${basename}.${docsExportFormatDescriptors[format].extension}`;
}

export function renderMarkdown(document: DocsExportDocument, includeComments = false): string {
  const body =
    document.markdown ??
    markdownFromPlainText(document.plainText ?? textFromHtml(document.html) ?? "");
  const lines = [`# ${document.title}`, "", body.trim()];
  if (document.outline !== undefined && document.outline.length > 0) {
    lines.push("", "## Outline", "");
    for (const item of document.outline) {
      lines.push(`${"  ".repeat(Math.max(item.level - 1, 0))}- ${item.title}`);
    }
  }
  if (includeComments && document.comments !== undefined && document.comments.length > 0) {
    lines.push("", "## Comments", "");
    for (const comment of document.comments) {
      const author =
        comment.author?.displayName ?? comment.author?.email ?? comment.author?.id ?? "Unknown";
      lines.push(`- ${author}: ${comment.body}`);
    }
  }
  return `${lines.filter((line, index) => index < 2 || line.length > 0 || lines[index - 1] !== "").join("\n")}\n`;
}

export function renderPlainText(document: DocsExportDocument, includeComments = false): string {
  return stripMarkdown(renderMarkdown(document, includeComments));
}

function resultFromBuffer(input: {
  readonly docId: string;
  readonly format: DocsExportFormat;
  readonly filename: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
  readonly text?: string | undefined;
  readonly metadata: JsonObject;
}): DocsExportResult {
  return {
    docId: input.docId,
    format: input.format,
    filename: input.filename,
    mimeType: input.mimeType,
    byteSize: input.buffer.byteLength,
    contentBase64: input.buffer.toString("base64"),
    ...(input.text === undefined ? {} : { text: input.text }),
    metadata: input.metadata,
  };
}

function markdownFromPlainText(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .join("\n");
}

function textFromHtml(html: string | undefined): string | undefined {
  return html
    ?.replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .trim();
}

function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*]\s+/gmu, "")
    .replace(/[`*_~>]/gu, "")
    .replace(/\[(.*?)\]\([^)]*\)/gu, "$1")
    .trim();
}

function renderPdfScaffold(title: string, text: string): Buffer {
  const lines = [title, "", ...text.split(/\r?\n/u)].slice(0, 42).map((line) => line.slice(0, 96));
  const stream = [
    "BT",
    "/F1 18 Tf",
    "72 750 Td",
    `(${escapePdfText(lines[0] ?? title)}) Tj`,
    "/F1 10 Tf",
    ...lines.slice(1).map((line) => `0 -16 Td (${escapePdfText(line)}) Tj`),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${String(Buffer.byteLength(stream, "utf8"))} >>\nstream\n${stream}\nendstream`,
  ];
  return renderPdf(objects);
}

function renderPdf(objects: readonly string[]): Buffer {
  const chunks: string[] = ["%PDF-1.4\n"];
  const offsets: number[] = [0];
  let byteOffset = Buffer.byteLength(chunks[0] ?? "", "utf8");
  objects.forEach((object, index) => {
    offsets.push(byteOffset);
    const chunk = `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
    chunks.push(chunk);
    byteOffset += Buffer.byteLength(chunk, "utf8");
  });
  const xrefOffset = byteOffset;
  const xref = [
    `xref\n0 ${String(objects.length + 1)}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
  ].join("\n");
  chunks.push(xref);
  return Buffer.from(chunks.join(""), "utf8");
}

function escapePdfText(text: string): string {
  return text.replace(/[\\()]/gu, "\\$&").replace(/[^\x20-\x7E]/gu, "?");
}

function renderDocxScaffold(title: string, markdown: string): Buffer {
  const paragraphs = stripMarkdown(markdown)
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  return zipStore([
    {
      name: "[Content_Types].xml",
      data: xmlBuffer(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`),
    },
    {
      name: "_rels/.rels",
      data: xmlBuffer(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`),
    },
    {
      name: "word/document.xml",
      data: xmlBuffer(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphXml(title, true)}
    ${paragraphs.map((line) => paragraphXml(line, false)).join("\n    ")}
    <w:sectPr/>
  </w:body>
</w:document>`),
    },
  ]);
}

function paragraphXml(text: string, title: boolean): string {
  const style = title ? '<w:pPr><w:pStyle w:val="Title"/></w:pPr>' : "";
  return `<w:p>${style}<w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}

function xmlBuffer(text: string): Buffer {
  return Buffer.from(text.trim(), "utf8");
}

function escapeXml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function zipStore(entries: readonly { readonly name: string; readonly data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.byteLength, 20);
    central.writeUInt32LE(entry.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + entry.data.byteLength;
  }

  const centralSize = centralParts.reduce((size, part) => size + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
