/* eslint-disable @typescript-eslint/restrict-template-expressions */
import type { DriveCommentListItem } from "../drive/types.js";
import {
  formatSlidesExportCommentLines,
  slidesExportCommentCountForSlide,
  slidesExportCommentThreadsForSlide,
  type SlidesExportCommentThread,
} from "./export-comments.js";
import type { SlideContent, SlideDeckSummaryRecord, SlideRecord, SlideShape } from "./types.js";

const PDF_MIME = "application/pdf";
const SVG_SERIES_MIME = "application/zip";
const SVG_WIDTH = 1600;
const SVG_HEIGHT = 900;
const PDF_WIDTH = 960;
const PDF_HEIGHT = 540;

export interface SlidesPdfExportResult {
  readonly deckId: string;
  readonly format: "pdf";
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentBase64: string;
  readonly metadata: {
    readonly generatedBy: "helix.slides.export.pdf";
    readonly slideCount: number;
    readonly commentCount: number;
    readonly fidelity: "first-pass-native-layouts";
  };
}

export interface SlidesImageSeriesExportResult {
  readonly deckId: string;
  readonly format: "svg-series";
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentBase64: string;
  readonly metadata: {
    readonly generatedBy: "helix.slides.export.svg-series";
    readonly slideCount: number;
    readonly commentCount: number;
    readonly imageFormat: "svg";
    readonly fidelity: "first-pass-native-layouts";
  };
}

interface PdfObject {
  readonly id: number;
  readonly body: string;
}

export async function exportSlidesDeckToPdf(
  deck: SlideDeckSummaryRecord,
  slides: readonly SlideRecord[],
  comments: readonly DriveCommentListItem[] = [],
): Promise<SlidesPdfExportResult> {
  const sourceSlides = slides.length > 0 ? slides : [emptyExportSlide(deck)];
  const buffer = renderPdf(deck, sourceSlides, comments);
  return {
    deckId: deck.id,
    format: "pdf",
    filename: `${exportFilenameStem(deck.title)}.pdf`,
    mimeType: PDF_MIME,
    byteSize: buffer.byteLength,
    contentBase64: buffer.toString("base64"),
    metadata: {
      generatedBy: "helix.slides.export.pdf",
      slideCount: sourceSlides.length,
      commentCount: sourceSlides.reduce(
        (count, slide) => count + slidesExportCommentCountForSlide(comments, slide.id),
        0,
      ),
      fidelity: "first-pass-native-layouts",
    },
  };
}

export async function exportSlidesDeckToImageSeries(
  deck: SlideDeckSummaryRecord,
  slides: readonly SlideRecord[],
  comments: readonly DriveCommentListItem[] = [],
): Promise<SlidesImageSeriesExportResult> {
  const sourceSlides = slides.length > 0 ? slides : [emptyExportSlide(deck)];
  const files = new Map<string, Uint8Array>();
  files.set(
    "manifest.json",
    encodeText(
      JSON.stringify(
        {
          deckId: deck.id,
          title: deck.title,
          format: "svg-series",
          slideCount: sourceSlides.length,
          slides: sourceSlides.map((slide, index) => ({
            id: slide.id,
            position: slide.position,
            filename: slideImageFilename(index),
            title: slide.content.title,
            commentCount: slidesExportCommentCountForSlide(comments, slide.id),
          })),
        },
        null,
        2,
      ),
    ),
  );
  for (const [index, slide] of sourceSlides.entries()) {
    files.set(
      slideImageFilename(index),
      encodeText(
        renderSlideSvg(
          deck,
          slide,
          index,
          sourceSlides.length,
          slidesExportCommentThreadsForSlide(comments, slide.id),
        ),
      ),
    );
  }
  const buffer = createStoredZip(files);
  return {
    deckId: deck.id,
    format: "svg-series",
    filename: `${exportFilenameStem(deck.title)}-svg-series.zip`,
    mimeType: SVG_SERIES_MIME,
    byteSize: buffer.byteLength,
    contentBase64: buffer.toString("base64"),
    metadata: {
      generatedBy: "helix.slides.export.svg-series",
      slideCount: sourceSlides.length,
      commentCount: sourceSlides.reduce(
        (count, slide) => count + slidesExportCommentCountForSlide(comments, slide.id),
        0,
      ),
      imageFormat: "svg",
      fidelity: "first-pass-native-layouts",
    },
  };
}

export function exportFilenameStem(title: string): string {
  const stem = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem.length > 0 ? stem : "presentation";
}

function renderSlideSvg(
  deck: SlideDeckSummaryRecord,
  slide: SlideRecord,
  index: number,
  count: number,
  comments: readonly SlidesExportCommentThread[],
): string {
  const content = slide.content;
  const body = renderSvgContent(content);
  const shapes = (content.shapes ?? []).map(renderSvgShape).join("\n");
  const commentBlock = renderSvgCommentBlock(comments);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-label="${escapeXml(
    content.title,
  )}">
  <rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="${content.layout === "title" && content.bg !== "neutral" ? "#e8f1f8" : "#ffffff"}"/>
  ${body}
  ${shapes}
  ${commentBlock}
  <text x="64" y="852" font-family="Inter, Arial, sans-serif" font-size="18" fill="#667085">${escapeXml(
    deck.title,
  )}</text>
  <text x="1470" y="852" text-anchor="end" font-family="Inter, Arial, sans-serif" font-size="18" fill="#667085">${String(
    index + 1,
  )} / ${String(count)}</text>
</svg>
`;
}

function renderSvgCommentBlock(comments: readonly SlidesExportCommentThread[]): string {
  const lines = formatSlidesExportCommentLines(comments, { maxLines: 5, maxBodyLength: 84 });
  if (lines.length === 0) {
    return "";
  }
  return [
    `<rect x="72" y="652" width="1456" height="${76 + Math.max(0, lines.length - 1) * 30}" rx="14" fill="#fff7e6" stroke="#f79009"/>`,
    ...lines.map((line, index) =>
      svgText(line, 98, 696 + index * 30, {
        size: index === 0 ? 24 : 21,
        weight: index === 0 ? 800 : 500,
        fill: "#344054",
      }),
    ),
  ].join("\n");
}

function renderSvgContent(content: SlideContent): string {
  switch (content.layout) {
    case "title":
      return [
        content.eyebrow === undefined
          ? ""
          : svgText(content.eyebrow, 104, 170, { size: 26, weight: 700, fill: "#2f5c8a" }),
        svgText(content.title, 104, 290, { size: 72, weight: 800, fill: "#111827" }),
        content.subtitle === undefined
          ? ""
          : svgText(content.subtitle, 108, 390, { size: 34, fill: "#475467" }),
      ].join("\n");
    case "agenda":
      return [
        svgTitle(content.title),
        ...content.items
          .slice(0, 10)
          .map((item, index) =>
            svgText(`${String(index + 1)}. ${item}`, 140, 185 + index * 56, { size: 34 }),
          ),
      ].join("\n");
    case "stats":
      return [
        svgTitle(content.title),
        ...(content.subtitle === undefined
          ? []
          : [svgText(content.subtitle, 90, 152, { size: 26, fill: "#667085" })]),
        ...content.stats.slice(0, 6).map((stat, index) => {
          const column = index % 3;
          const row = Math.floor(index / 3);
          const x = 110 + column * 470;
          const y = 260 + row * 225;
          return [
            svgText(stat.value, x, y, { size: 58, weight: 800, fill: "#2f5c8a" }),
            svgText(stat.label, x, y + 48, { size: 28, weight: 700 }),
            svgText(stat.note, x, y + 84, { size: 22, fill: "#667085" }),
          ].join("\n");
        }),
      ].join("\n");
    case "split":
      return [
        svgTitle(content.title),
        svgParagraph(content.left, 90, 175, 590, 34),
        `<rect x="835" y="150" width="640" height="560" rx="18" fill="#f2f4f7" stroke="#d0d5dd"/>`,
        svgParagraph(splitRightText(content.rightContent, content.quoteWho), 890, 220, 520, 34),
      ].join("\n");
    case "bullets":
      return [
        svgTitle(content.title),
        ...content.items
          .slice(0, 10)
          .map((item, index) => svgText(`• ${item}`, 140, 190 + index * 58, { size: 36 })),
      ].join("\n");
    case "image":
      return [
        svgTitle(content.title),
        `<rect x="170" y="185" width="1260" height="520" rx="22" fill="#f2f4f7" stroke="#d0d5dd"/>`,
        svgText(content.note || "Image placeholder", 800, 460, {
          size: 38,
          fill: "#475467",
          anchor: "middle",
        }),
      ].join("\n");
  }
}

function renderSvgShape(shape: SlideShape): string {
  const x = percent(shape.x, SVG_WIDTH);
  const y = percent(shape.y, SVG_HEIGHT);
  const width = percent(shape.width, SVG_WIDTH);
  const height = percent(shape.height, SVG_HEIGHT);
  if (shape.kind === "connector") {
    const x1 = x;
    const y1 = shape.connectorDirection === "down" ? y : y + height;
    const x2 = x + width;
    const y2 = shape.connectorDirection === "down" ? y + height : y;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${shapeColor(shape)}" stroke-width="6" stroke-linecap="round"/>`;
  }
  if (shape.kind === "image" && shape.imageUrl !== undefined && shape.imageUrl.length > 0) {
    const preserveAspectRatio = shape.imageFit === "contain" ? "xMidYMid meet" : "xMidYMid slice";
    const title = `<title>${escapeXml(shape.imageAlt ?? "Image")}</title>`;
    const image = `<image href="${escapeXml(shape.imageUrl)}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="${preserveAspectRatio}"${svgImageMaskClip(shape)}>${title}</image>`;
    return `${svgImageMaskDef(shape, x, y, width, height)}${image}`;
  }
  if (
    shape.kind === "media" &&
    shape.mediaType !== "audio" &&
    shape.mediaPosterUrl !== undefined &&
    shape.mediaPosterUrl.length > 0
  ) {
    return `<image href="${escapeXml(shape.mediaPosterUrl)}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"><title>${escapeXml(
      shape.mediaTitle ?? "Video",
    )}</title></image>`;
  }
  const fill = shape.kind === "text" ? "rgba(255,255,255,0.78)" : shapeFill(shape);
  return [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="14" fill="${fill}" stroke="${shapeColor(
      shape,
    )}" stroke-width="3"/>`,
    shape.text === undefined || shape.text.length === 0
      ? ""
      : svgText(shape.text, x + 22, y + Math.min(54, height / 2 + 10), {
          size: Math.max(18, Math.min(34, height / 3)),
          weight: shape.kind === "text" ? 700 : 600,
          fill: shape.tone === "dark" ? "#f8fafc" : "#111827",
        }),
  ].join("\n");
}

function svgImageMaskDef(
  shape: SlideShape,
  x: number,
  y: number,
  width: number,
  height: number,
): string {
  const radius = svgImageMaskRadius(shape, width, height);
  if (radius === null) {
    return "";
  }
  return `<defs><clipPath id="${svgImageMaskId(shape)}"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" ry="${radius}"/></clipPath></defs>`;
}

function svgImageMaskClip(shape: SlideShape): string {
  return svgImageMaskRadius(shape, 0, 0) === null
    ? ""
    : ` clip-path="url(#${svgImageMaskId(shape)})"`;
}

function svgImageMaskRadius(shape: SlideShape, width: number, height: number): number | null {
  if (shape.imageMask === "rectangle") {
    return null;
  }
  if (shape.imageMask === "circle") {
    return Math.min(width, height) / 2;
  }
  if (shape.imageMask === "rounded") {
    return 18;
  }
  return 18;
}

function svgImageMaskId(shape: SlideShape): string {
  return `image-mask-${shape.id.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
}

function renderPdf(
  deck: SlideDeckSummaryRecord,
  slides: readonly SlideRecord[],
  comments: readonly DriveCommentListItem[],
): Buffer {
  const objects: PdfObject[] = [];
  const pageIds: number[] = [];
  let nextId = 1;
  const catalogId = nextId++;
  const pagesId = nextId++;
  const fontId = nextId++;
  for (const [index, slide] of slides.entries()) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);
    const stream = pdfPageStream(
      deck,
      slide,
      index,
      slides.length,
      slidesExportCommentThreadsForSlide(comments, slide.id),
    );
    objects.push({
      id: pageId,
      body: `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PDF_WIDTH} ${PDF_HEIGHT}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    });
    objects.push({
      id: contentId,
      body: `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    });
  }
  objects.unshift({ id: fontId, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" });
  objects.unshift({
    id: pagesId,
    body: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
  });
  objects.unshift({ id: catalogId, body: `<< /Type /Catalog /Pages ${pagesId} 0 R >>` });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const object of objects.sort((left, right) => left.id - right.id)) {
    offsets[object.id] = Buffer.byteLength(pdf, "latin1");
    pdf += `${object.id} 0 obj\n${object.body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${nextId}\n0000000000 65535 f \n`;
  for (let id = 1; id < nextId; id += 1) {
    pdf += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${nextId} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function pdfPageStream(
  deck: SlideDeckSummaryRecord,
  slide: SlideRecord,
  index: number,
  count: number,
  comments: readonly SlidesExportCommentThread[],
): string {
  const lines = slideTextLines(slide.content);
  const commands = ["1 1 1 rg 0 0 960 540 re f", "0 0 0 rg"];
  commands.push(pdfText(slide.content.title, 54, 472, 28));
  for (const [lineIndex, line] of lines.slice(0, 11).entries()) {
    commands.push(pdfText(line, 72, 420 - lineIndex * 30, 18));
  }
  for (const [shapeIndex, shape] of (slide.content.shapes ?? []).slice(0, 5).entries()) {
    commands.push(
      pdfText(
        `Shape ${String(shapeIndex + 1)}: ${shape.kind}${shape.text === undefined ? "" : ` - ${shape.text}`}`,
        72,
        120 - shapeIndex * 22,
        12,
      ),
    );
  }
  for (const [commentIndex, line] of formatSlidesExportCommentLines(comments, {
    maxLines: 4,
    maxBodyLength: 90,
  }).entries()) {
    commands.push(pdfText(line, 54, 104 - commentIndex * 14, commentIndex === 0 ? 10 : 8));
  }
  if (slide.speakerNotes.trim().length > 0) {
    commands.push(pdfText(`Notes: ${slide.speakerNotes.trim().slice(0, 160)}`, 54, 44, 10));
  }
  commands.push(pdfText(deck.title, 54, 22, 9));
  commands.push(pdfText(`${String(index + 1)} / ${String(count)}`, 872, 22, 9));
  return commands.join("\n");
}

function slideTextLines(content: SlideContent): readonly string[] {
  switch (content.layout) {
    case "title":
      return [content.eyebrow, content.subtitle].filter(isNonEmptyString);
    case "agenda":
      return content.items.map((item, index) => `${String(index + 1)}. ${item}`);
    case "stats":
      return [
        content.subtitle,
        ...content.stats.map((stat) => `${stat.value} ${stat.label} ${stat.note}`),
      ].filter(isNonEmptyString);
    case "split":
      return [content.left, splitRightText(content.rightContent, content.quoteWho)];
    case "bullets":
      return content.items.map((item) => `• ${item}`);
    case "image":
      return [content.note || "Image placeholder"];
  }
}

function splitRightText(value: string | readonly string[], quoteWho?: string): string {
  const body = typeof value === "string" ? value : value.map((item) => `• ${item}`).join("\n");
  return quoteWho === undefined || quoteWho.trim().length === 0 ? body : `${body}\n- ${quoteWho}`;
}

function pdfText(text: string, x: number, y: number, size: number): string {
  return `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escapePdf(text)}) Tj ET`;
}

function svgTitle(title: string): string {
  return svgText(title, 78, 96, { size: 50, weight: 800, fill: "#111827" });
}

function svgText(
  text: string,
  x: number,
  y: number,
  options: {
    readonly size: number;
    readonly weight?: number | undefined;
    readonly fill?: string | undefined;
    readonly anchor?: "start" | "middle" | "end" | undefined;
  },
): string {
  return `<text x="${x}" y="${y}"${options.anchor === undefined ? "" : ` text-anchor="${options.anchor}"`} font-family="Inter, Arial, sans-serif" font-size="${options.size}" font-weight="${options.weight ?? 400}" fill="${options.fill ?? "#333333"}">${escapeXml(
    text,
  )}</text>`;
}

function svgParagraph(text: string, x: number, y: number, maxWidth: number, size: number): string {
  return wrapText(text, Math.max(12, Math.floor(maxWidth / (size * 0.55))))
    .slice(0, 12)
    .map((line, index) => svgText(line, x, y + index * (size + 10), { size }))
    .join("\n");
}

function wrapText(text: string, maxChars: number): readonly string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current.length === 0 ? word : `${current} ${word}`;
    if (next.length > maxChars && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

function createStoredZip(files: ReadonlyMap<string, Uint8Array>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [filename, data] of files) {
    const name = encodeText(filename);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, Buffer.from(name), Buffer.from(data));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, Buffer.from(name));
    offset += local.byteLength + name.byteLength + data.byteLength;
  }
  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(central.byteLength, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function emptyExportSlide(deck: SlideDeckSummaryRecord): SlideRecord {
  const now = new Date(0);
  return {
    id: deck.id,
    orgId: deck.orgId,
    deckId: deck.id,
    position: 0,
    layout: "title",
    content: { layout: "title", title: deck.title, subtitle: "No slides yet", bg: "neutral" },
    speakerNotes: "",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function slideImageFilename(index: number): string {
  return `slide-${String(index + 1).padStart(3, "0")}.svg`;
}

function percent(value: number, total: number): number {
  return Math.round((value / 100) * total);
}

function shapeColor(shape: SlideShape): string {
  if (shape.tone === "dark") return "#111827";
  if (shape.tone === "light") return "#d0d5dd";
  return "#2f5c8a";
}

function shapeFill(shape: SlideShape): string {
  if (shape.tone === "dark") return "#1f2937";
  if (shape.tone === "light") return "#f8fafc";
  return "#dbeafe";
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapePdf(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
