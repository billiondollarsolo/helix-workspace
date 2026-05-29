import { createRequire } from "node:module";
import { XMLParser } from "fast-xml-parser";
import type { SlideContent } from "./types.js";

const requireCjs = createRequire(import.meta.url);
const JSZip = requireCjs("jszip") as JsZipLoader;

interface JsZipLoader {
  loadAsync(content: Buffer): Promise<JsZipArchive>;
}

interface JsZipArchive {
  readonly files: Record<string, unknown>;
  file(path: string): JsZipFile | null;
}

interface JsZipFile {
  async(type: "string"): Promise<string>;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  preserveOrder: true,
  trimValues: true,
});

export interface ImportedPptxSlide {
  readonly content: SlideContent;
  readonly speakerNotes: string;
}

export interface ImportedPptxDeck {
  readonly title: string;
  readonly slides: readonly ImportedPptxSlide[];
  readonly metadata: {
    readonly sourceFormat: string;
    readonly slideCount: number;
    readonly fidelity: "first-pass-text";
  };
}

export async function importPptxDeck(input: {
  readonly filename: string;
  readonly title?: string | undefined;
  readonly content: Buffer;
}): Promise<ImportedPptxDeck> {
  const zip = await JSZip.loadAsync(input.content);
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/u.test(path))
    .sort(comparePptxNumberedPaths);

  if (slidePaths.length === 0) {
    throw new Error("PPTX import did not find any slides.");
  }

  const slides: ImportedPptxSlide[] = [];
  for (const [index, slidePath] of slidePaths.entries()) {
    const slideXml = await zip.file(slidePath)?.async("string");
    if (slideXml === undefined) {
      continue;
    }
    const lines = normalizePptxTextRuns(collectXmlTextRuns(slideXml));
    const notesXml = await zip
      .file(`ppt/notesSlides/notesSlide${String(index + 1)}.xml`)
      ?.async("string");
    const speakerNotes =
      notesXml === undefined ? "" : normalizePptxTextRuns(collectXmlTextRuns(notesXml)).join("\n");
    slides.push({
      content: slideContentFromPptxLines(lines, index),
      speakerNotes,
    });
  }

  if (slides.length === 0) {
    throw new Error("PPTX import did not find readable slide content.");
  }

  const title =
    input.title?.trim() || slides[0]?.content.title.trim() || titleFromPptxFilename(input.filename);

  return {
    title,
    slides,
    metadata: {
      sourceFormat: presentationSourceFormat(input.filename),
      slideCount: slides.length,
      fidelity: "first-pass-text",
    },
  };
}

function slideContentFromPptxLines(lines: readonly string[], index: number): SlideContent {
  const title = lines[0]?.trim() || `Imported slide ${String(index + 1)}`;
  const body = lines.slice(1).filter((line) => line.trim().length > 0);
  if (body.length === 0) {
    return {
      layout: "title",
      title,
      bg: index === 0 ? "accent" : "neutral",
    };
  }
  return {
    layout: "bullets",
    title,
    items: body.slice(0, 24),
  };
}

function collectXmlTextRuns(xml: string): readonly string[] {
  const parsed = xmlParser.parse(xml) as unknown;
  const runs: string[] = [];
  collectTextRuns(parsed, runs);
  return runs;
}

function collectTextRuns(node: unknown, runs: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectTextRuns(child, runs);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "a:t") {
      const text = xmlNodeText(value).trim();
      if (text.length > 0) {
        runs.push(text);
      }
      continue;
    }
    collectTextRuns(value, runs);
  }
}

function xmlNodeText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(xmlNodeText).join("");
  }
  if (typeof node !== "object" || node === null) {
    return "";
  }
  return Object.entries(node)
    .map(([key, value]) => (key === "#text" ? String(value) : xmlNodeText(value)))
    .join("");
}

function normalizePptxTextRuns(runs: readonly string[]): readonly string[] {
  return runs
    .map((run) => run.replaceAll(/\s+/gu, " ").trim())
    .filter((run, index, normalized) => run.length > 0 && normalized.indexOf(run) === index)
    .slice(0, 80);
}

function comparePptxNumberedPaths(left: string, right: string): number {
  return pptxPathNumber(left) - pptxPathNumber(right);
}

function pptxPathNumber(path: string): number {
  return Number(path.match(/(\d+)\.xml$/u)?.[1] ?? "0");
}

function titleFromPptxFilename(filename: string): string {
  return filename.replace(/\.(pptx|pptm|potx|potm|ppsx)$/iu, "").trim() || "Imported presentation";
}

function presentationSourceFormat(filename: string): string {
  const extension = /\.([^.\\/]+)$/u.exec(filename.trim())?.[1]?.toLowerCase();
  switch (extension) {
    case "pptx":
    case "pptm":
    case "potx":
    case "potm":
    case "ppsx":
      return extension;
    default:
      return "pptx";
  }
}
