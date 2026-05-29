import { createRequire } from "node:module";
import type { DriveCommentListItem } from "../drive/types.js";
import {
  formatSlidesExportCommentLines,
  slidesExportCommentCountForSlide,
  slidesExportCommentThreadsForSlide,
  type SlidesExportCommentThread,
} from "./export-comments.js";
import type { SlideContent, SlideDeckSummaryRecord, SlideRecord, SlideShape } from "./types.js";

const requireCjs = createRequire(import.meta.url);

interface PptxSlide {
  addText(text: string, options: Record<string, unknown>): void;
  addShape(shapeName: string, options: Record<string, unknown>): void;
  addImage(options: Record<string, unknown>): void;
}

interface PptxPresentation {
  layout: string;
  author: string;
  subject: string;
  title: string;
  company: string;
  lang: string;
  addSlide(): PptxSlide;
  write(options: { readonly outputType: "nodebuffer" }): Promise<Buffer>;
}

const PptxGen = requireCjs("pptxgenjs") as new () => PptxPresentation;

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const SLIDE_WIDTH = 13.333;
const SLIDE_HEIGHT = 7.5;

export interface SlidesPptxExportResult {
  readonly deckId: string;
  readonly format: "pptx";
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentBase64: string;
  readonly metadata: {
    readonly generatedBy: "helix.slides.export.pptx";
    readonly slideCount: number;
    readonly commentCount: number;
    readonly fidelity: "first-pass-native-layouts";
  };
}

export async function exportSlidesDeckToPptx(
  deck: SlideDeckSummaryRecord,
  slides: readonly SlideRecord[],
  comments: readonly DriveCommentListItem[] = [],
): Promise<SlidesPptxExportResult> {
  const pres = new PptxGen();
  pres.layout = "LAYOUT_WIDE";
  pres.author = "Helix";
  pres.company = "Helix";
  pres.lang = "en-US";
  pres.subject = "Native Helix Slides export";
  pres.title = deck.title;

  const sourceSlides = slides.length > 0 ? slides : [emptyExportSlide(deck)];
  for (const [index, slide] of sourceSlides.entries()) {
    renderPptxSlide(
      pres.addSlide(),
      deck,
      slide,
      index,
      sourceSlides.length,
      slidesExportCommentThreadsForSlide(comments, slide.id),
    );
  }

  const buffer = Buffer.from(await pres.write({ outputType: "nodebuffer" }));
  return {
    deckId: deck.id,
    format: "pptx",
    filename: `${exportFilenameStem(deck.title)}.pptx`,
    mimeType: PPTX_MIME,
    byteSize: buffer.byteLength,
    contentBase64: buffer.toString("base64"),
    metadata: {
      generatedBy: "helix.slides.export.pptx",
      slideCount: sourceSlides.length,
      commentCount: sourceSlides.reduce(
        (count, slide) => count + slidesExportCommentCountForSlide(comments, slide.id),
        0,
      ),
      fidelity: "first-pass-native-layouts",
    },
  };
}

function renderPptxSlide(
  pptxSlide: PptxSlide,
  deck: SlideDeckSummaryRecord,
  slide: SlideRecord,
  index: number,
  count: number,
  comments: readonly SlidesExportCommentThread[],
): void {
  pptxSlide.addText(deck.title, {
    x: 0.45,
    y: 6.95,
    w: 4.5,
    h: 0.25,
    fontSize: 8,
    color: "888888",
  });
  pptxSlide.addText(`${String(index + 1)} / ${String(count)}`, {
    x: 12.05,
    y: 6.95,
    w: 0.85,
    h: 0.25,
    fontSize: 8,
    align: "right",
    color: "888888",
  });

  switch (slide.content.layout) {
    case "title":
      renderTitleSlide(pptxSlide, slide.content);
      break;
    case "agenda":
      addSlideTitle(pptxSlide, slide.content.title);
      pptxSlide.addText(numberedLines(slide.content.items), bodyBox({ y: 1.45 }));
      break;
    case "stats":
      addSlideTitle(pptxSlide, slide.content.title, slide.content.subtitle);
      for (const [statIndex, stat] of slide.content.stats.slice(0, 6).entries()) {
        const column = statIndex % 3;
        const row = Math.floor(statIndex / 3);
        const x = 0.75 + column * 4.15;
        const y = 1.75 + row * 2.1;
        pptxSlide.addText(stat.value, {
          x,
          y,
          w: 3.3,
          h: 0.55,
          fontSize: 28,
          bold: true,
          color: "2F5C8A",
        });
        pptxSlide.addText(`${stat.label}\n${stat.note}`, {
          x,
          y: y + 0.62,
          w: 3.3,
          h: 0.8,
          fontSize: 13,
          color: "333333",
          breakLine: false,
          fit: "shrink",
        });
      }
      break;
    case "split":
      addSlideTitle(pptxSlide, slide.content.title);
      pptxSlide.addText(slide.content.left, bodyBox({ x: 0.75, y: 1.35, w: 5.6, h: 4.85 }));
      pptxSlide.addText(splitRightText(slide.content.rightContent, slide.content.quoteWho), {
        ...bodyBox({ x: 7.0, y: 1.35, w: 5.35, h: 4.85 }),
        color: slide.content.rightKind === "quote" ? "2F5C8A" : "333333",
        italic: slide.content.rightKind === "quote",
      });
      break;
    case "bullets":
      addSlideTitle(pptxSlide, slide.content.title);
      pptxSlide.addText(bulletLines(slide.content.items), bodyBox({ y: 1.45 }));
      break;
    case "image":
      addSlideTitle(pptxSlide, slide.content.title);
      pptxSlide.addText(slide.content.note || "Image placeholder", {
        x: 1.1,
        y: 1.6,
        w: 11.1,
        h: 4.6,
        fontSize: 20,
        color: "555555",
        align: "center",
        valign: "mid",
        fill: { color: "F2F4F7" },
        line: { color: "D0D5DD" },
        fit: "shrink",
      });
      break;
  }

  renderPptxShapes(pptxSlide, slide.content.shapes ?? []);
  renderPptxCommentBlock(pptxSlide, comments);
  if (slide.speakerNotes.trim().length > 0) {
    pptxSlide.addText(`Notes: ${slide.speakerNotes.trim().slice(0, 500)}`, {
      x: 0.75,
      y: 6.45,
      w: 11.8,
      h: 0.28,
      fontSize: 8,
      color: "666666",
      fit: "shrink",
    });
  }
}

function renderPptxCommentBlock(
  pptxSlide: PptxSlide,
  comments: readonly SlidesExportCommentThread[],
): void {
  const lines = formatSlidesExportCommentLines(comments, { maxLines: 4, maxBodyLength: 80 });
  if (lines.length === 0) {
    return;
  }
  pptxSlide.addText(lines.join("\n"), {
    x: 0.75,
    y: 5.78,
    w: 11.8,
    h: 0.58,
    fontSize: 7,
    color: "344054",
    fit: "shrink",
    breakLine: false,
    fill: { color: "FFF7E6", transparency: 12 },
    line: { color: "F79009" },
    margin: 0.04,
  });
}

function renderTitleSlide(
  pptxSlide: PptxSlide,
  content: SlideContent & { readonly layout: "title" },
): void {
  const bgColor = content.bg === "neutral" ? "F4F5F7" : "E8F1F8";
  pptxSlide.addText("", {
    x: 0,
    y: 0,
    w: SLIDE_WIDTH,
    h: SLIDE_HEIGHT,
    fill: { color: bgColor },
  });
  if (content.eyebrow !== undefined && content.eyebrow.trim().length > 0) {
    pptxSlide.addText(content.eyebrow, {
      x: 0.85,
      y: 1.25,
      w: 9.6,
      h: 0.35,
      fontSize: 12,
      bold: true,
      color: "2F5C8A",
      fit: "shrink",
    });
  }
  pptxSlide.addText(content.title, {
    x: 0.85,
    y: 1.8,
    w: 10.8,
    h: 1.25,
    fontSize: 40,
    bold: true,
    color: "111827",
    fit: "shrink",
  });
  if (content.subtitle !== undefined && content.subtitle.trim().length > 0) {
    pptxSlide.addText(content.subtitle, {
      x: 0.9,
      y: 3.25,
      w: 9.8,
      h: 0.75,
      fontSize: 18,
      color: "475467",
      fit: "shrink",
    });
  }
}

function addSlideTitle(pptxSlide: PptxSlide, title: string, subtitle?: string): void {
  pptxSlide.addText(title, {
    x: 0.65,
    y: 0.45,
    w: 11.7,
    h: 0.55,
    fontSize: 26,
    bold: true,
    color: "111827",
    fit: "shrink",
  });
  if (subtitle !== undefined && subtitle.trim().length > 0) {
    pptxSlide.addText(subtitle, {
      x: 0.68,
      y: 1.05,
      w: 10.8,
      h: 0.35,
      fontSize: 13,
      color: "667085",
      fit: "shrink",
    });
  }
}

function bodyBox(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    x: 0.85,
    y: 1.55,
    w: 11.55,
    h: 4.9,
    fontSize: 17,
    color: "333333",
    valign: "top",
    fit: "shrink",
    breakLine: false,
    ...overrides,
  };
}

function renderPptxShapes(pptxSlide: PptxSlide, shapes: readonly SlideShape[]): void {
  for (const shape of shapes.slice(0, 40)) {
    const box = percentBox(shape);
    if (shape.kind === "rectangle") {
      pptxSlide.addText(shape.text ?? "", {
        ...box,
        fontSize: 12,
        color: shape.tone === "dark" ? "FFFFFF" : "111827",
        align: "center",
        valign: "mid",
        fit: "shrink",
        fill: { color: shapeFillColor(shape.tone) },
        line: { color: "98A2B3" },
      });
    } else if (shape.kind === "text") {
      pptxSlide.addText(shape.text ?? "", {
        ...box,
        fontSize: 14,
        color: shape.tone === "light" ? "475467" : "111827",
        fit: "shrink",
      });
    } else if (shape.kind === "connector") {
      renderPptxConnector(pptxSlide, shape);
    } else if (shape.kind === "image") {
      if (!renderPptxImage(pptxSlide, shape, shape.imageUrl, shape.imageAlt ?? "Image")) {
        renderPptxShapePlaceholder(pptxSlide, shape, box);
      }
    } else {
      if (
        shape.mediaType !== "audio" &&
        !renderPptxImage(pptxSlide, shape, shape.mediaPosterUrl, shape.mediaTitle ?? "Video")
      ) {
        renderPptxShapePlaceholder(pptxSlide, shape, box);
      }
    }
  }
}

function renderPptxConnector(pptxSlide: PptxSlide, shape: SlideShape): void {
  const arrow = shape.connectorArrow ?? "none";
  pptxSlide.addShape(shape.connectorDirection === "up" ? "lineInv" : "line", {
    ...percentBox(shape),
    line: {
      color: shape.tone === "dark" ? "344054" : "2F5C8A",
      width: 2,
      beginArrowType: arrow === "start" || arrow === "both" ? "triangle" : "none",
      endArrowType: arrow === "end" || arrow === "both" ? "triangle" : "none",
    },
  });
}

function renderPptxImage(
  pptxSlide: PptxSlide,
  shape: SlideShape,
  url: string | undefined,
  altText: string,
): boolean {
  const data = imageDataFromDataUri(url);
  if (data === null) {
    return false;
  }
  const box = percentBox(shape);
  pptxSlide.addImage({
    data,
    ...box,
    altText,
    sizing: {
      type: shape.imageFit === "contain" ? "contain" : "cover",
      w: box.w,
      h: box.h,
    },
    rounding: shape.imageMask === "rounded" || shape.imageMask === "circle",
  });
  return true;
}

function renderPptxShapePlaceholder(
  pptxSlide: PptxSlide,
  shape: SlideShape,
  box: Record<string, number>,
): void {
  pptxSlide.addText(shapePlaceholderText(shape), {
    ...box,
    fontSize: 10,
    color: "475467",
    align: "center",
    valign: "mid",
    fit: "shrink",
    fill: { color: "F9FAFB" },
    line: { color: "D0D5DD", dash: "dash" },
  });
}

function percentBox(shape: SlideShape): Record<string, number> {
  return {
    x: (shape.x / 100) * SLIDE_WIDTH,
    y: (shape.y / 100) * SLIDE_HEIGHT,
    w: (shape.width / 100) * SLIDE_WIDTH,
    h: (shape.height / 100) * SLIDE_HEIGHT,
  };
}

function shapeFillColor(tone: SlideShape["tone"]): string {
  if (tone === "dark") return "344054";
  if (tone === "accent") return "D6EAF8";
  return "F2F4F7";
}

function shapePlaceholderText(shape: SlideShape): string {
  if (shape.kind === "image") {
    return shape.imageAlt?.trim() || shape.imageUrl?.trim() || "Image";
  }
  if (shape.kind === "media") {
    return shape.mediaTitle?.trim() || shape.mediaUrl?.trim() || "Media";
  }
  if (shape.connectorArrow === "start") {
    return "<- Connector";
  }
  if (shape.connectorArrow === "both") {
    return "<- Connector ->";
  }
  return shape.connectorArrow === "end" ? "Connector ->" : "Connector";
}

function imageDataFromDataUri(value: string | undefined): string | null {
  const match = value?.match(/^data:(image\/(?:png|jpeg|jpg|gif));base64,([A-Za-z0-9+/=]+)$/u);
  if (match === undefined || match === null) {
    return null;
  }
  const rawMimeType = match[1];
  const payload = match[2];
  if (rawMimeType === undefined || payload === undefined) {
    return null;
  }
  const mimeType = rawMimeType === "image/jpg" ? "image/jpeg" : rawMimeType;
  return `${mimeType};base64,${payload}`;
}

function bulletLines(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function numberedLines(items: readonly string[]): string {
  return items.map((item, index) => `${String(index + 1)}. ${item}`).join("\n");
}

function splitRightText(rightContent: string | readonly string[], quoteWho?: string): string {
  const body = typeof rightContent === "string" ? rightContent : bulletLines(rightContent);
  if (quoteWho === undefined || quoteWho.trim().length === 0) {
    return body;
  }
  return `${body}\n\n${quoteWho}`;
}

function exportFilenameStem(title: string): string {
  const stem = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return stem.length > 0 ? stem : "presentation";
}

function emptyExportSlide(deck: SlideDeckSummaryRecord): SlideRecord {
  return {
    id: deck.id,
    orgId: deck.orgId,
    deckId: deck.id,
    position: 0,
    layout: "title",
    content: { layout: "title", title: deck.title, subtitle: "No slides yet", bg: "neutral" },
    speakerNotes: "",
    revision: 1,
    createdAt: deck.createdAt,
    updatedAt: deck.updatedAt,
  };
}
