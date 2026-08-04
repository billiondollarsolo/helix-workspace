import type { JsonObject } from "@helix/sdk-types";
import {
  docsExportFormatDescriptors,
  type DocsCommentProjection,
  type DocsExportDocument,
  type DocsExportFormat,
  type DocsExportResult,
} from "../types.js";
import { sanitizeHtmlForExport } from "./sanitize-html.js";

export interface ExportDocsDocumentInput {
  readonly document: DocsExportDocument;
  readonly format: DocsExportFormat;
  readonly includeComments?: boolean | undefined;
  readonly filename?: string | undefined;
}

export interface PdfExportRenderInput {
  readonly document: DocsExportDocument;
  readonly title: string;
  readonly markdown: string;
  readonly plainText: string;
  readonly html: string;
  readonly includeComments: boolean;
}

export interface PdfExportRenderResult {
  readonly buffer: Buffer;
  readonly metadata?: JsonObject | undefined;
}

export interface PdfExportRenderer {
  render(input: PdfExportRenderInput): Promise<PdfExportRenderResult>;
}

export interface ExportDocsDocumentProviderOptions {
  readonly pdfRenderer?: PdfExportRenderer | undefined;
  readonly onPdfRendererError?: ((error: unknown) => void) | undefined;
}

interface NativeDocumentTokenRenderOptions {
  readonly references?: "text" | "markdown-link";
}

type RenderMarkdownOptions = NativeDocumentTokenRenderOptions;

interface NativeDocumentExportLayout {
  readonly layoutMode: "page" | "pageless";
  readonly columnCount: 1 | 2;
  readonly pageSize: "letter" | "a4";
  readonly orientation: "portrait" | "landscape";
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
      buffer: renderPdfScaffold(renderNativeDocumentExportTokens(input.document.title), text),
      metadata: { generatedBy: "helix.docs.export.pdf", deterministic: true },
    });
  }

  if (input.format === "epub") {
    const markdown = renderMarkdown(input.document, input.includeComments === true);
    return resultFromBuffer({
      docId: input.document.id,
      format: input.format,
      filename,
      mimeType: descriptor.mimeType,
      buffer: renderEpubScaffold(input.document, markdown),
      metadata: { generatedBy: "helix.docs.export.epub", deterministic: true },
    });
  }

  const docxComments =
    input.includeComments === true ? docxCommentsFromDocument(input.document) : [];
  const docxMarkdown = renderMarkdown(input.document, false, { references: "text" });
  return resultFromBuffer({
    docId: input.document.id,
    format: input.format,
    filename,
    mimeType: descriptor.mimeType,
    buffer: renderDocxScaffold(
      renderNativeDocumentExportTokens(input.document.title),
      docxMarkdown,
      docxComments,
      nativeDocumentExportLayout(input.document),
    ),
    metadata: { generatedBy: "helix.docs.export.docx", deterministic: true },
  });
}

export async function exportDocsDocumentWithProviders(
  input: ExportDocsDocumentInput,
  providers: ExportDocsDocumentProviderOptions = {},
): Promise<DocsExportResult> {
  if (input.format !== "pdf" || providers.pdfRenderer === undefined) {
    return exportDocsDocument(input);
  }

  const filename = input.filename ?? defaultExportFilename(input.document.title, input.format);
  const descriptor = docsExportFormatDescriptors[input.format];
  const includeComments = input.includeComments === true;
  const markdown = renderMarkdown(input.document, includeComments);
  const plainText = stripMarkdown(markdown);
  try {
    const rendered = await providers.pdfRenderer.render({
      document: input.document,
      title: renderNativeDocumentExportTokens(input.document.title),
      markdown,
      plainText,
      html: renderHtmlForPdf(input.document, markdown),
      includeComments,
    });
    return resultFromBuffer({
      docId: input.document.id,
      format: input.format,
      filename,
      mimeType: descriptor.mimeType,
      buffer: rendered.buffer,
      metadata: {
        generatedBy: "helix.docs.export.pdf.chromium",
        renderer: "headless-chromium",
        ...(rendered.metadata ?? {}),
      },
    });
  } catch (error) {
    providers.onPdfRendererError?.(error);
    const fallback = exportDocsDocument(input);
    return {
      ...fallback,
      metadata: {
        ...fallback.metadata,
        fallback: true,
        fallbackFrom: "headless-chromium",
      },
    };
  }
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

export function renderMarkdown(
  document: DocsExportDocument,
  includeComments = false,
  options: RenderMarkdownOptions = { references: "markdown-link" },
): string {
  const body =
    document.markdown ??
    markdownFromPlainText(document.plainText ?? textFromHtml(document.html) ?? "");
  const lines = [
    `# ${renderNativeDocumentExportTokens(document.title)}`,
    "",
    renderNativeDocumentExportTokens(body, options).trim(),
  ];
  if (document.outline !== undefined && document.outline.length > 0) {
    lines.push("", "## Outline", "");
    for (const item of document.outline) {
      const title = renderNativeDocumentExportTokens(item.title);
      const body =
        options.references === "text"
          ? title
          : `[${escapeMarkdownLinkLabel(title)}](#${epubAnchorId(item.anchor || item.id)})`;
      lines.push(`${"  ".repeat(Math.max(item.level - 1, 0))}- ${body}`);
    }
  }
  if (includeComments && document.comments !== undefined && document.comments.length > 0) {
    lines.push("", "## Comments", "");
    for (const comment of document.comments) {
      const author =
        comment.author?.displayName ?? comment.author?.email ?? comment.author?.id ?? "Unknown";
      lines.push(
        `- ${renderNativeDocumentExportTokens(author)}: ${renderNativeDocumentExportTokens(comment.body)}`,
      );
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

function escapeMarkdownLinkLabel(text: string): string {
  return text.replace(/\\/gu, "\\\\").replace(/\[/gu, "\\[").replace(/\]/gu, "\\]");
}

function renderNativeDocumentExportTokens(
  text: string,
  options: NativeDocumentTokenRenderOptions = {},
): string {
  const references = options.references ?? "text";
  return text
    .replace(/\{\{DATE\s+([^}]+)\}\}/gu, "$1")
    .replace(/\{\{TIME\s+([^}]+)\}\}/gu, "$1")
    .replace(/\{\{PAGE\}\}/gu, "1")
    .replace(/\{\{AUTHOR\s+([^}]+)\}\}/gu, "$1")
    .replace(/\{\{PROPERTY\s+title="([^"]*)"\}\}/gu, "$1")
    .replace(/\{\{EQUATION\s+latex="([^"]*)"\}\}/gu, "Equation: $1")
    .replace(/\{\{BOOKMARK\s+\S+\s+"[^"]*"\}\}/gu, "")
    .replace(/\{\{REF\s+(\S+)\s+"([^"]*)"\}\}/gu, (_token, id: string, label: string) =>
      references === "markdown-link"
        ? `[${escapeMarkdownLinkLabel(label)}](#${epubAnchorId(id)})`
        : label,
    )
    .replace(/\{\{CHIP\s+(?:person|doc|event)\s+label="([^"]*)"(?:\s+id="[^"]*")?\}\}/gu, "$1");
}

function renderHtmlForPdf(document: DocsExportDocument, markdown: string): string {
  if (document.html !== undefined && document.html.trim().length > 0) {
    // Untrusted document HTML: must be sanitized before it reaches Chromium.
    // See sanitize-html.ts and CRITICAL-6 in docs/reviews/REVIEW.md.
    return sanitizeHtmlForExport(renderNativeDocumentExportTokens(document.html));
  }
  const layout = nativeDocumentExportLayout(document);
  const body = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      if (line.startsWith("# ")) {
        return `<h1>${markdownInlineToHtml(line.slice(2))}</h1>`;
      }
      if (line.startsWith("## ")) {
        return `<h2>${markdownInlineToHtml(line.slice(3))}</h2>`;
      }
      if (line.startsWith("- ")) {
        return `<p class="list-item">${markdownInlineToHtml(line.slice(2))}</p>`;
      }
      return `<p>${markdownInlineToHtml(line)}</p>`;
    })
    .join("\n");
  return sanitizeHtmlForExport(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: ${layout.pageSize === "a4" ? "A4" : "Letter"} ${layout.orientation}; margin: 0.75in; }
      body { color: #111827; font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.45; }
      .document-body { max-width: ${layout.layoutMode === "pageless" ? "none" : "7in"}; margin: 0 auto; column-count: ${String(layout.columnCount)}; column-gap: 40pt; }
      h1 { font-size: 24pt; margin: 0 0 18pt; }
      h2 { font-size: 15pt; margin: 16pt 0 8pt; }
      p { margin: 0 0 8pt; }
      .list-item { margin-left: 18pt; }
    </style>
  </head>
  <body class="layout-${layout.layoutMode} columns-${String(layout.columnCount)}">
    <main class="document-body">
    ${body}
    </main>
  </body>
</html>`);
}

function nativeDocumentExportLayout(document: DocsExportDocument): NativeDocumentExportLayout {
  const metadata = document.metadata;
  const layout = metadata?.nativeDocumentLayout;
  if (layout === null || typeof layout !== "object" || Array.isArray(layout)) {
    return { layoutMode: "page", columnCount: 1, pageSize: "letter", orientation: "portrait" };
  }
  const candidate = layout as Record<string, unknown>;
  const section = firstNativeDocumentSection(candidate.sections);
  return {
    layoutMode: candidate.layoutMode === "pageless" ? "pageless" : "page",
    columnCount: section?.columnCount ?? (candidate.columnCount === 2 ? 2 : 1),
    pageSize: section?.pageSize ?? "letter",
    orientation: section?.orientation ?? "portrait",
  };
}

function firstNativeDocumentSection(value: unknown): {
  readonly columnCount?: 1 | 2;
  readonly pageSize?: "letter" | "a4";
  readonly orientation?: "portrait" | "landscape";
} | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const section = value.find(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
  if (section === undefined) {
    return null;
  }
  return {
    ...(section.columnCount === 1 || section.columnCount === 2
      ? { columnCount: section.columnCount }
      : {}),
    ...(section.pageSize === "letter" || section.pageSize === "a4"
      ? { pageSize: section.pageSize }
      : {}),
    ...(section.orientation === "portrait" || section.orientation === "landscape"
      ? { orientation: section.orientation }
      : {}),
  };
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

interface DocxComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly anchorText?: string | undefined;
}

interface DocxParagraph {
  readonly text: string;
  readonly runs?: readonly DocxTextRun[] | undefined;
  readonly styleId?: DocxParagraphStyleId | undefined;
  readonly comments: readonly DocxCommentRange[];
}

interface DocxTable {
  readonly rows: readonly (readonly string[])[];
}

interface DocxImage {
  readonly relationshipId: string;
  readonly mediaPath: string;
  readonly contentType: string;
  readonly extension: string;
  readonly altText: string;
  readonly data: Buffer;
}

interface DocxTextRun {
  readonly text: string;
  readonly bold?: boolean | undefined;
  readonly italic?: boolean | undefined;
  readonly code?: boolean | undefined;
  readonly hyperlinkId?: string | undefined;
  readonly hyperlinkUrl?: string | undefined;
}

type DocxParagraphStyleId =
  | "Heading1"
  | "Heading2"
  | "Heading3"
  | "Heading4"
  | "Heading5"
  | "Heading6"
  | "ListBullet"
  | "ListNumber";

type DocxBlock =
  | {
      readonly kind: "paragraph";
      readonly paragraphIndex: number;
      readonly text: string;
      readonly runs?: readonly DocxTextRun[] | undefined;
      readonly styleId?: DocxParagraphStyleId | undefined;
    }
  | {
      readonly kind: "table";
      readonly table: DocxTable;
    }
  | {
      readonly kind: "image";
      readonly image: DocxImage;
    };

interface DocxCommentRange {
  readonly comment: DocxComment;
  readonly start: number;
  readonly end: number;
}

function renderDocxScaffold(
  title: string,
  markdown: string,
  comments: readonly DocxComment[] = [],
  layout: NativeDocumentExportLayout = {
    layoutMode: "page",
    columnCount: 1,
    pageSize: "letter",
    orientation: "portrait",
  },
): Buffer {
  const blocks = docxBlocksFromMarkdown(markdown);
  const images = blocks.filter(isDocxImageBlock).map((block) => block.image);
  const hyperlinks = docxHyperlinksFromBlocks(blocks);
  const paragraphBlocks = blocks.filter(isDocxParagraphBlock);
  const paragraphs = paragraphBlocks.map((block) => block.text);
  const paragraphComments = assignDocxCommentsToParagraphs(paragraphs, comments);
  const hasStyles = blocks.some(
    (block) => block.kind === "paragraph" && block.styleId !== undefined,
  );
  const hasComments = comments.length > 0;
  const hasDocumentRelationships =
    hasComments || images.length > 0 || hasStyles || hyperlinks.length > 0;
  const entries: { readonly name: string; readonly data: Buffer }[] = [
    {
      name: "[Content_Types].xml",
      data: xmlBuffer(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${docxImageContentTypeDefaults(images)}
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  ${
    hasStyles
      ? '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
      : ""
  }
  ${
    hasComments
      ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>'
      : ""
  }
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
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${paragraphXml(title, true, paragraphComments.fallbackComments)}
    ${blocks.map((block) => docxBlockXml(block, paragraphComments.paragraphs, paragraphBlocks)).join("\n    ")}
    <w:sectPr>${docxSectionPropertiesXml(layout)}</w:sectPr>
  </w:body>
</w:document>`),
    },
  ];
  if (hasDocumentRelationships) {
    entries.push({
      name: "word/_rels/document.xml.rels",
      data: xmlBuffer(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${
    hasComments
      ? '<Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>'
      : ""
  }
  ${
    hasStyles
      ? '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      : ""
  }
  ${hyperlinks.map(docxHyperlinkRelationshipXml).join("\n  ")}
  ${images.map(docxImageRelationshipXml).join("\n  ")}
</Relationships>`),
    });
  }
  if (hasStyles) {
    entries.push({
      name: "word/styles.xml",
      data: xmlBuffer(docxStylesXml()),
    });
  }
  if (hasComments) {
    entries.push({
      name: "word/comments.xml",
      data: xmlBuffer(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  ${comments.map(docxCommentXml).join("\n  ")}
</w:comments>`),
    });
  }
  for (const image of images) {
    entries.push({
      name: image.mediaPath,
      data: image.data,
    });
  }
  return zipStore(entries);
}

function docxSectionPropertiesXml(layout: NativeDocumentExportLayout): string {
  const width = layout.pageSize === "a4" ? 11906 : 12240;
  const height = layout.pageSize === "a4" ? 16838 : 15840;
  const pageSize =
    layout.orientation === "landscape"
      ? `<w:pgSz w:w="${String(height)}" w:h="${String(width)}" w:orient="landscape"/>`
      : `<w:pgSz w:w="${String(width)}" w:h="${String(height)}"/>`;
  const columns = layout.columnCount === 2 ? '<w:cols w:num="2" w:space="720"/>' : "";
  return `${pageSize}${columns}`;
}

function docxBlocksFromMarkdown(markdown: string): readonly DocxBlock[] {
  const blocks: DocxBlock[] = [];
  const lines = renderNativeDocumentExportTokens(markdown).split(/\r?\n/u);
  let paragraphIndex = 0;
  let hyperlinkIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length === 0) {
      continue;
    }
    const imageLine = markdownImageLine(line);
    if (imageLine !== null) {
      const image = docxImageFromMarkdownImage(
        imageLine,
        blocks.filter(isDocxImageBlock).length + 1,
      );
      if (image !== null) {
        blocks.push({ kind: "image", image });
      } else {
        blocks.push({
          kind: "paragraph",
          paragraphIndex,
          text: fallbackDocxImageText(imageLine),
        });
        paragraphIndex += 1;
      }
      continue;
    }
    const nextLine = lines[index + 1]?.trim() ?? "";
    if (isMarkdownTableRow(line) && isMarkdownTableSeparator(nextLine)) {
      const rows = [markdownTableCells(line)];
      index += 2;
      while (index < lines.length) {
        const rowLine = lines[index]?.trim() ?? "";
        if (!isMarkdownTableRow(rowLine)) {
          index -= 1;
          break;
        }
        rows.push(markdownTableCells(rowLine));
        index += 1;
      }
      blocks.push({ kind: "table", table: normalizeDocxTableRows(rows) });
      continue;
    }
    const paragraph = docxParagraphFromMarkdownLine(line, hyperlinkIndex);
    hyperlinkIndex += paragraph.hyperlinkCount;
    blocks.push({
      kind: "paragraph",
      paragraphIndex,
      text: paragraph.text,
      runs: paragraph.runs,
      styleId: paragraph.styleId,
    });
    paragraphIndex += 1;
  }
  return blocks;
}

function docxParagraphFromMarkdownLine(
  line: string,
  hyperlinkOffset = 0,
): {
  readonly text: string;
  readonly runs: readonly DocxTextRun[];
  readonly hyperlinkCount: number;
  readonly styleId?: DocxParagraphStyleId | undefined;
} {
  const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
  if (heading !== null) {
    return docxParagraphFromInlineMarkdown(
      heading[2]?.trim() ?? "",
      hyperlinkOffset,
      `Heading${String(Math.min(heading[1]?.length ?? 1, 6))}` as DocxParagraphStyleId,
    );
  }
  const bullet = /^[-*+]\s+(.+)$/u.exec(line);
  if (bullet !== null) {
    return docxParagraphFromInlineMarkdown(bullet[1]?.trim() ?? "", hyperlinkOffset, "ListBullet");
  }
  const numbered = /^\d+[.)]\s+(.+)$/u.exec(line);
  if (numbered !== null) {
    return docxParagraphFromInlineMarkdown(
      numbered[1]?.trim() ?? "",
      hyperlinkOffset,
      "ListNumber",
    );
  }
  return docxParagraphFromInlineMarkdown(line, hyperlinkOffset);
}

function docxParagraphFromInlineMarkdown(
  text: string,
  hyperlinkOffset: number,
  styleId?: DocxParagraphStyleId,
): {
  readonly text: string;
  readonly runs: readonly DocxTextRun[];
  readonly hyperlinkCount: number;
  readonly styleId?: DocxParagraphStyleId | undefined;
} {
  const inline = docxInlineRunsFromMarkdown(text, hyperlinkOffset);
  return {
    text: docxTextFromRuns(inline.runs),
    runs: inline.runs,
    hyperlinkCount: inline.hyperlinkCount,
    ...(styleId === undefined ? {} : { styleId }),
  };
}

function docxInlineRunsFromMarkdown(
  text: string,
  hyperlinkOffset = 0,
): { readonly runs: readonly DocxTextRun[]; readonly hyperlinkCount: number } {
  const runs: DocxTextRun[] = [];
  let cursor = 0;
  let hyperlinkCount = 0;
  while (cursor < text.length) {
    const next = nextInlineMarkdownToken(text, cursor, hyperlinkOffset + hyperlinkCount);
    if (next === null) {
      pushDocxTextRun(runs, { text: stripInlineMarkdownText(text.slice(cursor)) });
      break;
    }
    if (next.start > cursor) {
      pushDocxTextRun(runs, { text: stripInlineMarkdownText(text.slice(cursor, next.start)) });
    }
    pushDocxTextRun(runs, next.run);
    if (next.run.hyperlinkId !== undefined) {
      hyperlinkCount += 1;
    }
    cursor = next.end;
  }
  return { runs: runs.filter((run) => run.text.length > 0), hyperlinkCount };
}

function nextInlineMarkdownToken(
  text: string,
  from: number,
  hyperlinkOffset: number,
): { readonly start: number; readonly end: number; readonly run: DocxTextRun } | null {
  const candidates = [
    inlineMarkdownLinkRun(text, from, hyperlinkOffset),
    inlineDelimitedRun(text, from, "`", { code: true }),
    inlineDelimitedRun(text, from, "**", { bold: true }),
    inlineDelimitedRun(text, from, "__", { bold: true }),
    inlineDelimitedRun(text, from, "*", { italic: true }),
    inlineDelimitedRun(text, from, "_", { italic: true }),
  ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
  if (candidates.length === 0) {
    return null;
  }
  return (
    candidates.sort((left, right) => left.start - right.start || right.end - left.end)[0] ?? null
  );
}

function inlineMarkdownLinkRun(
  text: string,
  from: number,
  hyperlinkOffset: number,
): { readonly start: number; readonly end: number; readonly run: DocxTextRun } | null {
  const match = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/u.exec(text.slice(from));
  if (match === null) {
    return null;
  }
  const label = match[1] ?? "";
  const url = match[2] ?? "";
  return {
    start: from + match.index,
    end: from + match.index + match[0].length,
    run: {
      text: stripInlineMarkdownText(label),
      hyperlinkId: `rIdHyperlink${String(hyperlinkOffset + 1)}`,
      hyperlinkUrl: url,
    },
  };
}

function inlineDelimitedRun(
  text: string,
  from: number,
  delimiter: string,
  style: Omit<DocxTextRun, "text">,
): { readonly start: number; readonly end: number; readonly run: DocxTextRun } | null {
  const start = text.indexOf(delimiter, from);
  if (start < 0) {
    return null;
  }
  if (delimiter.length === 1 && text.slice(start, start + 2) === delimiter.repeat(2)) {
    return inlineDelimitedRun(text, start + 2, delimiter, style);
  }
  const contentStart = start + delimiter.length;
  const end = text.indexOf(delimiter, contentStart);
  if (end <= contentStart) {
    return null;
  }
  return {
    start,
    end: end + delimiter.length,
    run: { text: text.slice(contentStart, end), ...style },
  };
}

function pushDocxTextRun(runs: DocxTextRun[], run: DocxTextRun): void {
  if (run.text.length === 0) {
    return;
  }
  const previous = runs.at(-1);
  if (
    previous !== undefined &&
    previous.bold === run.bold &&
    previous.italic === run.italic &&
    previous.code === run.code &&
    previous.hyperlinkId === run.hyperlinkId &&
    previous.hyperlinkUrl === run.hyperlinkUrl
  ) {
    runs[runs.length - 1] = { ...previous, text: `${previous.text}${run.text}` };
    return;
  }
  runs.push(run);
}

function docxTextFromRuns(runs: readonly DocxTextRun[]): string {
  return runs.map((run) => run.text).join("");
}

function docxHyperlinksFromBlocks(
  blocks: readonly DocxBlock[],
): readonly { readonly relationshipId: string; readonly url: string }[] {
  const hyperlinks = new Map<string, string>();
  for (const block of blocks) {
    if (block.kind !== "paragraph") {
      continue;
    }
    for (const run of block.runs ?? []) {
      if (run.hyperlinkId !== undefined && run.hyperlinkUrl !== undefined) {
        hyperlinks.set(run.hyperlinkId, run.hyperlinkUrl);
      }
    }
  }
  return [...hyperlinks.entries()].map(([relationshipId, url]) => ({ relationshipId, url }));
}

function stripInlineMarkdownText(text: string): string {
  return text.replace(/[`*_~>]/gu, "").replace(/\[(.*?)\]\([^)]*\)/gu, "$1");
}

function isDocxParagraphBlock(
  block: DocxBlock,
): block is Extract<DocxBlock, { readonly kind: "paragraph" }> {
  return block.kind === "paragraph";
}

function isDocxImageBlock(
  block: DocxBlock,
): block is Extract<DocxBlock, { readonly kind: "image" }> {
  return block.kind === "image";
}

function markdownImageLine(
  line: string,
): { readonly altText: string; readonly source: string } | null {
  const match = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/u.exec(line);
  if (match === null) {
    return null;
  }
  return {
    altText: stripMarkdown(match[1] ?? ""),
    source: match[2] ?? "",
  };
}

function docxImageFromMarkdownImage(
  image: { readonly altText: string; readonly source: string },
  imageNumber: number,
): DocxImage | null {
  const dataUri = image.source;
  const data = /^data:(image\/(?:png|jpe?g|gif));base64,([a-z0-9+/=]+)$/iu.exec(dataUri);
  if (data === null) {
    return null;
  }
  const contentType = data[1]?.toLowerCase() ?? "";
  const encoded = data[2] ?? "";
  const extension = docxImageExtension(contentType);
  if (extension === null) {
    return null;
  }
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.byteLength === 0) {
    return null;
  }
  return {
    relationshipId: `rIdImage${String(imageNumber)}`,
    mediaPath: `word/media/image${String(imageNumber)}.${extension}`,
    contentType: docxImageContentType(contentType),
    extension,
    altText: image.altText,
    data: buffer,
  };
}

function fallbackDocxImageText(image: {
  readonly altText: string;
  readonly source: string;
}): string {
  const altText = image.altText.trim();
  return altText.length === 0 ? `Image: ${image.source}` : `Image: ${altText}`;
}

function docxImageExtension(contentType: string): string | null {
  if (contentType === "image/png") {
    return "png";
  }
  if (contentType === "image/jpeg" || contentType === "image/jpg") {
    return "jpg";
  }
  return contentType === "image/gif" ? "gif" : null;
}

function docxImageContentType(contentType: string): string {
  return contentType === "image/jpg" ? "image/jpeg" : contentType;
}

function isMarkdownTableRow(line: string): boolean {
  return line.includes("|") && markdownTableCells(line).length > 1;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = markdownTableCells(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell.replace(/\s+/gu, "")));
}

function markdownTableCells(line: string): readonly string[] {
  const trimmed = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return trimmed.split("|").map((cell) => stripMarkdown(cell.trim()));
}

function normalizeDocxTableRows(rows: readonly (readonly string[])[]): DocxTable {
  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  return {
    rows: rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? "")),
  };
}

function docxBlockXml(
  block: DocxBlock,
  paragraphs: readonly DocxParagraph[],
  paragraphBlocks: readonly Extract<DocxBlock, { readonly kind: "paragraph" }>[],
): string {
  if (block.kind === "table") {
    return docxTableXml(block.table);
  }
  if (block.kind === "image") {
    return docxImageXml(block.image);
  }
  const paragraph = paragraphs[block.paragraphIndex];
  const paragraphBlock = paragraphBlocks[block.paragraphIndex];
  return paragraphXml(
    block.text,
    false,
    paragraph?.comments ?? [],
    block.styleId,
    paragraphBlock?.runs,
  );
}

function docxImageContentTypeDefaults(images: readonly DocxImage[]): string {
  const byExtension = new Map<string, string>();
  for (const image of images) {
    byExtension.set(image.extension, image.contentType);
  }
  return [...byExtension.entries()]
    .map(
      ([extension, contentType]) =>
        `<Default Extension="${escapeXmlAttribute(extension)}" ContentType="${escapeXmlAttribute(contentType)}"/>`,
    )
    .join("\n  ");
}

function docxImageRelationshipXml(image: DocxImage): string {
  return `<Relationship Id="${escapeXmlAttribute(image.relationshipId)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${escapeXmlAttribute(image.mediaPath.split("/").at(-1) ?? "")}"/>`;
}

function docxHyperlinkRelationshipXml(input: {
  readonly relationshipId: string;
  readonly url: string;
}): string {
  return `<Relationship Id="${escapeXmlAttribute(input.relationshipId)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXmlAttribute(input.url)}" TargetMode="External"/>`;
}

function docxImageXml(image: DocxImage): string {
  const docPrId = image.relationshipId.replace(/\D+/gu, "") || "1";
  const name = image.altText.trim() || "Embedded image";
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="4572000" cy="2571750"/><wp:docPr id="${escapeXmlAttribute(docPrId)}" name="${escapeXmlAttribute(name)}" descr="${escapeXmlAttribute(image.altText)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${escapeXmlAttribute(docPrId)}" name="${escapeXmlAttribute(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${escapeXmlAttribute(image.relationshipId)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="2571750"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function docxStylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>
  ${[1, 2, 3, 4, 5, 6]
    .map(
      (level) =>
        `<w:style w:type="paragraph" w:styleId="Heading${String(level)}"><w:name w:val="heading ${String(level)}"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="${String(level - 1)}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${String(Math.max(20, 36 - level * 2))}"/></w:rPr></w:style>`,
    )
    .join("\n  ")}
  <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:style>
</w:styles>`;
}

function docxTableXml(table: DocxTable): string {
  const rows = table.rows.map(docxTableRowXml).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr>${rows}</w:tbl>`;
}

function docxTableRowXml(row: readonly string[]): string {
  return `<w:tr>${row.map(docxTableCellXml).join("")}</w:tr>`;
}

function docxTableCellXml(text: string): string {
  return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraphXml(text, false)}</w:tc>`;
}

function renderEpubScaffold(document: DocsExportDocument, markdown: string): Buffer {
  const headings = epubHeadingsFromDocument(document, markdown);
  const body = markdownToXhtmlBody(markdown, headings);
  const title = renderNativeDocumentExportTokens(document.title);
  const layout = nativeDocumentExportLayout(document);
  return zipStore([
    {
      name: "mimetype",
      data: Buffer.from("application/epub+zip", "utf8"),
    },
    {
      name: "META-INF/container.xml",
      data: xmlBuffer(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`),
    },
    {
      name: "OEBPS/content.opf",
      data: xmlBuffer(`<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="doc-id" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="doc-id">${escapeXml(document.id)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${epubModifiedTimestamp(document.updatedAt)}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="document" href="document.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="document"/>
  </spine>
</package>`),
    },
    {
      name: "OEBPS/nav.xhtml",
      data: xmlBuffer(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
  <head>
    <title>${escapeXml(title)} navigation</title>
  </head>
  <body>
    <nav epub:type="toc" id="toc" xmlns:epub="http://www.idpf.org/2007/ops">
      <h1>Table of contents</h1>
      ${epubNavigationList(headings)}
    </nav>
  </body>
</html>`),
    },
    {
      name: "OEBPS/document.xhtml",
      data: xmlBuffer(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
  <head>
    <title>${escapeXml(title)}</title>
    <style>
      body { line-height: 1.45; }
      body.page-a4 .document-body { max-width: 210mm; }
      body.orientation-landscape .document-body { max-width: 297mm; }
      .document-body.columns-2 { column-count: 2; column-gap: 2rem; }
      body.layout-pageless .document-body { max-width: none; }
    </style>
  </head>
  <body class="layout-${layout.layoutMode} page-${layout.pageSize} orientation-${layout.orientation}">
    <section class="document-body columns-${String(layout.columnCount)}">
${body}
    </section>
  </body>
</html>`),
    },
  ]);
}

interface EpubHeading {
  readonly id: string;
  readonly level: number;
  readonly title: string;
}

function epubHeadingsFromDocument(
  document: DocsExportDocument,
  markdown: string,
): readonly EpubHeading[] {
  const outline = document.outline ?? [];
  const usedOutlineIndexes = new Set<number>();
  const headings: EpubHeading[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const match = /^(#{1,6})\s+(.+)$/u.exec(line.trim());
    if (match === null) {
      continue;
    }
    const title = match[2]?.trim() ?? "";
    const outlineIndex = outline.findIndex(
      (item, index) => !usedOutlineIndexes.has(index) && item.title.trim() === title,
    );
    const outlineItem = outlineIndex < 0 ? undefined : outline[outlineIndex];
    if (outlineIndex >= 0) {
      usedOutlineIndexes.add(outlineIndex);
    }
    headings.push({
      id:
        outlineItem === undefined
          ? `heading-${String(headings.length + 1)}`
          : epubAnchorId(outlineItem.anchor || outlineItem.id),
      level: clampHeadingLevel(match[1]?.length ?? 1),
      title,
    });
  }
  return headings.filter((heading) => heading.title.length > 0);
}

function markdownToXhtmlBody(markdown: string, headings: readonly EpubHeading[]): string {
  let headingIndex = 0;
  const lines = markdown.split(/\r?\n/u);
  const parts: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.+)$/u.exec(trimmed);
    if (headingMatch !== null) {
      const heading = headings[headingIndex];
      headingIndex += 1;
      const level = clampHeadingLevel(headingMatch[1]?.length ?? heading?.level ?? 1);
      parts.push(
        `    <h${String(level)} id="${escapeXmlAttribute(heading?.id ?? `heading-${String(headingIndex)}`)}">${escapeXml(headingMatch[2]?.trim() ?? "")}</h${String(level)}>`,
      );
      continue;
    }
    if (/^[-*]\s+/u.test(trimmed)) {
      parts.push(
        `    <p class="list-item">${markdownInlineToXhtml(trimmed.replace(/^[-*]\s+/u, ""))}</p>`,
      );
      continue;
    }
    parts.push(`    <p>${markdownInlineToXhtml(trimmed)}</p>`);
  }
  return parts.join("\n");
}

function markdownInlineToHtml(text: string): string {
  return markdownInlineToMarkup(text, escapeHtml);
}

function markdownInlineToXhtml(text: string): string {
  return markdownInlineToMarkup(text, escapeXml);
}

function markdownInlineToMarkup(text: string, escapeText: (value: string) => string): string {
  const linkPattern = /\[([^\]]+)\]\((#[^) \t\r\n]+|https?:\/\/[^) \t\r\n]+)\)/gu;
  let cursor = 0;
  const parts: string[] = [];
  for (const match of text.matchAll(linkPattern)) {
    const index = match.index;
    if (index > cursor) {
      parts.push(escapeText(text.slice(cursor, index)));
    }
    const label = stripInlineMarkdownText(match[1] ?? "");
    const href = match[2] ?? "";
    parts.push(`<a href="${escapeXmlAttribute(href)}">${escapeText(label)}</a>`);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    parts.push(escapeText(text.slice(cursor)));
  }
  return parts.join("");
}

function epubNavigationList(headings: readonly EpubHeading[]): string {
  if (headings.length === 0) {
    return '<ol><li><a href="document.xhtml">Document</a></li></ol>';
  }
  const minimumLevel = Math.min(...headings.map((heading) => heading.level));
  const items = headings
    .map((heading) => {
      const indent = "  ".repeat(Math.max(heading.level - minimumLevel, 0));
      return `${indent}<li><a href="document.xhtml#${escapeXmlAttribute(heading.id)}">${escapeXml(heading.title)}</a></li>`;
    })
    .join("\n");
  return `<ol>\n${items}\n</ol>`;
}

function epubAnchorId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 80) || "heading"
  );
}

function clampHeadingLevel(level: number): number {
  return Number.isInteger(level) ? Math.min(Math.max(level, 1), 6) : 1;
}

/** Epoch fallback used when a document has no (or an unparseable) timestamp. */
const EXPORT_TIMESTAMP_EPOCH = "1970-01-01T00:00:00.000Z";

function exportTimestampDate(value: DocsExportDocument["updatedAt"]): Date {
  if (value === undefined) {
    return new Date(EXPORT_TIMESTAMP_EPOCH);
  }
  return value instanceof Date ? value : new Date(value);
}

function epubModifiedTimestamp(value: DocsExportDocument["updatedAt"]): string {
  const date = exportTimestampDate(value);
  if (!Number.isFinite(date.getTime())) {
    return "1970-01-01T00:00:00Z";
  }
  return date.toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function docxCommentsFromDocument(document: DocsExportDocument): readonly DocxComment[] {
  return (document.comments ?? []).map((comment, index) => {
    const author =
      comment.author?.displayName ?? comment.author?.email ?? comment.author?.id ?? "Unknown";
    return {
      id: index,
      author: renderNativeDocumentExportTokens(author),
      body: renderNativeDocumentExportTokens(comment.body),
      createdAt: docxCommentTimestamp(comment.createdAt),
      anchorText: docxCommentAnchorText(document.id, comment.anchor),
    };
  });
}

function docxCommentAnchorText(
  documentId: string,
  anchor: DocsCommentProjection["anchor"],
): string | undefined {
  if (anchor === undefined || typeof anchor === "string") {
    return undefined;
  }
  if (
    anchor.kind !== "native-document" ||
    anchor.target !== "selection" ||
    anchor.documentId !== documentId
  ) {
    return undefined;
  }
  const selection = anchor.selection;
  if (selection !== null && typeof selection === "object" && !Array.isArray(selection)) {
    const selectionText = (selection as Record<string, unknown>).text;
    if (typeof selectionText === "string" && selectionText.trim().length > 0) {
      return renderNativeDocumentExportTokens(selectionText);
    }
  }
  const quote = anchor.quote;
  return typeof quote === "string" && quote.trim().length > 0
    ? renderNativeDocumentExportTokens(quote)
    : undefined;
}

function assignDocxCommentsToParagraphs(
  paragraphs: readonly string[],
  comments: readonly DocxComment[],
): {
  readonly paragraphs: readonly DocxParagraph[];
  readonly fallbackComments: readonly DocxComment[];
} {
  const paragraphComments = paragraphs.map((): DocxCommentRange[] => []);
  const fallbackComments: DocxComment[] = [];

  for (const comment of comments) {
    let assigned = false;
    for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
      const range = docxCommentRangeInParagraph(paragraph, comment);
      if (range === null) {
        continue;
      }
      paragraphComments[paragraphIndex]?.push({ comment, ...range });
      assigned = true;
      break;
    }
    if (!assigned) {
      fallbackComments.push(comment);
    }
  }

  return {
    paragraphs: paragraphs.map((text, index) => ({
      text,
      comments: paragraphComments[index] ?? [],
    })),
    fallbackComments,
  };
}

function docxCommentRangeInParagraph(
  paragraph: string,
  comment: DocxComment,
): { readonly start: number; readonly end: number } | null {
  const anchorText = renderNativeDocumentExportTokens(comment.anchorText ?? "").trim();
  if (anchorText.length === 0) {
    return null;
  }
  const start = paragraph.toLocaleLowerCase().indexOf(anchorText.toLocaleLowerCase());
  return start < 0 ? null : { start, end: start + anchorText.length };
}

function docxCommentTimestamp(value: DocsExportDocument["updatedAt"]): string {
  const date = exportTimestampDate(value);
  if (!Number.isFinite(date.getTime())) {
    return "1970-01-01T00:00:00Z";
  }
  return date.toISOString();
}

function docxCommentXml(comment: DocxComment): string {
  return `<w:comment w:id="${String(comment.id)}" w:author="${escapeXmlAttribute(comment.author)}" w:date="${escapeXmlAttribute(comment.createdAt)}"><w:p><w:r><w:t>${escapeXml(comment.body)}</w:t></w:r></w:p></w:comment>`;
}

function paragraphXml(
  text: string,
  title: boolean,
  comments: readonly (DocxComment | DocxCommentRange)[] = [],
  styleId?: DocxParagraphStyleId,
  runs?: readonly DocxTextRun[],
): string {
  const resolvedStyleId = title ? "Title" : styleId;
  const style =
    resolvedStyleId === undefined
      ? ""
      : `<w:pPr><w:pStyle w:val="${escapeXmlAttribute(resolvedStyleId)}"/></w:pPr>`;
  const textRuns = normalizedDocxTextRuns(text, runs);
  const rangeComments = comments.filter(isDocxCommentRange);
  if (rangeComments.length === 0) {
    const wholeParagraphComments = comments.filter(isDocxComment);
    const rangeStarts = wholeParagraphComments
      .map((comment) => `<w:commentRangeStart w:id="${String(comment.id)}"/>`)
      .join("");
    const rangeEnds = wholeParagraphComments
      .map((comment) => docxCommentRangeEndXml(comment))
      .join("");
    return `<w:p>${style}${rangeStarts}${docxTextRunsXml(textRuns)}${rangeEnds}</w:p>`;
  }

  const ranges = [...rangeComments].sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    return right.end - left.end;
  });
  let cursor = 0;
  const parts: string[] = [];
  for (const range of ranges) {
    if (range.start < cursor) {
      continue;
    }
    parts.push(docxTextRunsSliceXml(textRuns, cursor, range.start));
    parts.push(`<w:commentRangeStart w:id="${String(range.comment.id)}"/>`);
    parts.push(docxTextRunsSliceXml(textRuns, range.start, range.end));
    parts.push(docxCommentRangeEndXml(range.comment));
    cursor = range.end;
  }
  parts.push(docxTextRunsSliceXml(textRuns, cursor));
  return `<w:p>${style}${parts.join("")}</w:p>`;
}

function normalizedDocxTextRuns(
  text: string,
  runs: readonly DocxTextRun[] | undefined,
): readonly DocxTextRun[] {
  if (runs === undefined || docxTextFromRuns(runs) !== text) {
    return text.length === 0 ? [] : [{ text }];
  }
  return runs;
}

function docxTextRunsXml(runs: readonly DocxTextRun[]): string {
  return runs.map(docxTextRunXml).join("");
}

function docxTextRunsSliceXml(
  runs: readonly DocxTextRun[],
  start: number,
  end = Number.POSITIVE_INFINITY,
): string {
  let offset = 0;
  const sliced: DocxTextRun[] = [];
  for (const run of runs) {
    const runStart = offset;
    const runEnd = offset + run.text.length;
    offset = runEnd;
    if (runEnd <= start || runStart >= end) {
      continue;
    }
    const textStart = Math.max(start, runStart) - runStart;
    const textEnd = Math.min(end, runEnd) - runStart;
    pushDocxTextRun(sliced, {
      ...run,
      text: run.text.slice(textStart, textEnd),
    });
  }
  return docxTextRunsXml(sliced);
}

function isDocxComment(input: DocxComment | DocxCommentRange): input is DocxComment {
  return "id" in input;
}

function isDocxCommentRange(input: DocxComment | DocxCommentRange): input is DocxCommentRange {
  return "comment" in input;
}

function docxTextRunXml(run: DocxTextRun): string {
  if (run.text.length === 0) {
    return "";
  }
  const properties = docxRunPropertiesXml(run);
  const preserveSpace = /^\s|\s$|\s{2,}/u.test(run.text) ? ' xml:space="preserve"' : "";
  const runXml = `<w:r>${properties}<w:t${preserveSpace}>${escapeXml(run.text)}</w:t></w:r>`;
  return run.hyperlinkId === undefined
    ? runXml
    : `<w:hyperlink r:id="${escapeXmlAttribute(run.hyperlinkId)}" w:history="1">${runXml}</w:hyperlink>`;
}

function docxRunPropertiesXml(run: DocxTextRun): string {
  const properties = [
    run.bold === true ? "<w:b/>" : "",
    run.italic === true ? "<w:i/>" : "",
    run.hyperlinkId !== undefined ? '<w:color w:val="0563C1"/><w:u w:val="single"/>' : "",
    run.code === true
      ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:shd w:fill="F3F4F6"/>'
      : "",
  ].join("");
  return properties.length === 0 ? "" : `<w:rPr>${properties}</w:rPr>`;
}

function docxCommentRangeEndXml(comment: DocxComment): string {
  return `<w:commentRangeEnd w:id="${String(comment.id)}"/><w:r><w:commentReference w:id="${String(comment.id)}"/></w:r>`;
}

function xmlBuffer(text: string): Buffer {
  return Buffer.from(text.trim(), "utf8");
}

function escapeXml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function escapeXmlAttribute(text: string): string {
  return escapeXml(text).replace(/"/gu, "&quot;");
}

function escapeHtml(text: string): string {
  return escapeXml(text).replace(/"/gu, "&quot;");
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
