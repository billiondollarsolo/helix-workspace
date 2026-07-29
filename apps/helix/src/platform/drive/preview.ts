// ponytail: local Office→PDF converter + LibreOffice client share one module; split if either path grows.
import { randomUUID } from "node:crypto";
import type { convertToHtml as mammothConvertToHtml } from "mammoth";
import type { Browser } from "playwright";
import { DriveForbiddenError } from "./errors.js";

export interface OfficePreviewConversionInput {
  readonly objectId: string;
  readonly name: string;
  readonly storageKey: string;
  readonly sourceMimeType: string;
  readonly content: Uint8Array;
}

export interface OfficePreviewConversionResult {
  readonly pdf: Uint8Array;
  readonly pageCount?: number;
  readonly generatedAt: string;
}

export interface OfficePreviewConverter {
  convert(input: OfficePreviewConversionInput): Promise<OfficePreviewConversionResult>;
}

export interface LibreOfficePreviewClientOptions {
  readonly endpoint: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  /** When non-empty, only these hostnames may be contacted (SSRF guard). */
  readonly allowedHosts?: readonly string[];
}

const BLOCKED_PREVIEW_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "metadata.google.internal",
  "169.254.169.254",
]);

/**
 * SSRF guard for the office-preview converter URL.
 * - requires http(s)
 * - blocks link-local / loopback / cloud-metadata hosts unless explicitly allowlisted
 * - when `allowedHosts` is non-empty, requires the host to be in the list
 */
export function assertPreviewUrlAllowed(url: string, allowedHosts: readonly string[] = []): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DriveForbiddenError("Office preview URL is not a valid absolute URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DriveForbiddenError("Office preview URL must use http or https.");
  }
  const host = parsed.hostname.toLowerCase();
  const allow = new Set(allowedHosts.map((h) => h.toLowerCase()));
  const isBlockedHost =
    BLOCKED_PREVIEW_HOSTS.has(host) ||
    host.endsWith(".local") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./u.test(host);
  if (isBlockedHost && !allow.has(host)) {
    throw new DriveForbiddenError(`Office preview host is not allowed: ${host}`);
  }
  if (allow.size > 0 && !allow.has(host)) {
    throw new DriveForbiddenError(`Office preview host is not allowlisted: ${host}`);
  }
}

export interface LocalOfficePreviewConverterOptions {
  readonly executablePath?: string;
  readonly now?: () => Date;
  readonly renderPdf?: LocalOfficePreviewPdfRenderer;
  readonly timeoutMs?: number;
}

export type LocalOfficePreviewPdfRenderer = (input: {
  readonly html: string;
  readonly filename: string;
  readonly executablePath?: string | undefined;
  readonly timeoutMs: number;
}) => Promise<Uint8Array>;

export function createLibreOfficePreviewClient(
  options: LibreOfficePreviewClientOptions,
): OfficePreviewConverter {
  return new LibreOfficePreviewClient(options);
}

export function createLocalOfficePreviewConverter(
  options: LocalOfficePreviewConverterOptions = {},
): OfficePreviewConverter {
  return new LocalOfficePreviewConverter(options);
}

export function officePreviewStorageKey(
  orgId: string,
  objectId: string,
  versionNumber: number,
): string {
  return `drive-previews/${orgId}/${objectId}/v${String(versionNumber)}/${randomUUID()}.pdf`;
}

class LibreOfficePreviewClient implements OfficePreviewConverter {
  readonly #endpoint: URL;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #allowedHosts: readonly string[];

  constructor(options: LibreOfficePreviewClientOptions) {
    this.#endpoint = new URL(options.endpoint);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#allowedHosts = options.allowedHosts ?? [];
    assertPreviewUrlAllowed(this.#endpoint.toString(), this.#allowedHosts);
  }

  async convert(input: OfficePreviewConversionInput): Promise<OfficePreviewConversionResult> {
    const url = new URL("/convert/office-to-pdf", this.#endpoint);
    assertPreviewUrlAllowed(url.toString(), this.#allowedHosts);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    const response = await this.#fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objectId: input.objectId,
        name: input.name,
        storageKey: input.storageKey,
        mimeType: input.sourceMimeType,
        contentBase64: Buffer.from(input.content).toString("base64"),
      }),
    }).finally(() => {
      clearTimeout(timeout);
    });
    if (!response.ok) {
      throw new Error(`LibreOffice preview conversion failed with HTTP ${String(response.status)}`);
    }

    const body = await response.json();
    if (!isConversionResponse(body)) {
      throw new Error("LibreOffice preview conversion returned an invalid response.");
    }

    return {
      pdf: Buffer.from(body.pdfBase64, "base64"),
      ...(body.pageCount === undefined ? {} : { pageCount: body.pageCount }),
      generatedAt: body.generatedAt ?? this.#now().toISOString(),
    };
  }
}

class LocalOfficePreviewConverter implements OfficePreviewConverter {
  readonly #now: () => Date;
  readonly #renderPdf: LocalOfficePreviewPdfRenderer;
  readonly #timeoutMs: number;
  readonly #executablePath: string | undefined;

  constructor(options: LocalOfficePreviewConverterOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#renderPdf = options.renderPdf ?? renderOfficePreviewPdfWithChromium;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#executablePath = options.executablePath;
  }

  async convert(input: OfficePreviewConversionInput): Promise<OfficePreviewConversionResult> {
    const html = await officePreviewHtml(input);
    const pdf = await this.#renderPdf({
      html,
      filename: input.name,
      executablePath: this.#executablePath,
      timeoutMs: this.#timeoutMs,
    });
    return {
      pdf,
      generatedAt: this.#now().toISOString(),
    };
  }
}

async function officePreviewHtml(input: OfficePreviewConversionInput): Promise<string> {
  const kind = officePreviewKind(input.sourceMimeType, input.name);
  if (kind === "document") {
    const mammothModule = (await import("mammoth")) as unknown as {
      readonly default?: { readonly convertToHtml: typeof mammothConvertToHtml };
      readonly convertToHtml: typeof mammothConvertToHtml;
    };
    const mammoth = mammothModule.default ?? mammothModule;
    const { value: html, messages } = await mammoth.convertToHtml({
      buffer: Buffer.from(input.content),
    });
    return wrapOfficePreview(
      input.name,
      html,
      messages.map((message) => message.message),
    );
  }

  if (kind === "spreadsheet") {
    return wrapOfficePreview(input.name, await renderSpreadsheetPreviewHtml(input.content), []);
  }

  if (kind === "presentation") {
    const { importPptxDeck } = await import("../slides/import-pptx.js");
    const deck = await importPptxDeck({
      filename: input.name,
      content: Buffer.from(input.content),
    });
    return wrapOfficePreview(input.name, renderPresentationPreviewHtml(deck.slides), []);
  }

  throw new Error(
    `Local Office preview conversion does not support ${input.name} (${input.sourceMimeType}).`,
  );
}

async function renderSpreadsheetPreviewHtml(content: Uint8Array): Promise<string> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(Buffer.from(content), {
    type: "buffer",
    cellDates: true,
    cellFormula: true,
    cellNF: true,
    sheetStubs: true,
  });
  const tables: string[] = [];
  for (const [sheetIndex, sheetName] of wb.SheetNames.slice(0, 12).entries()) {
    const sheet = wb.Sheets[sheetName];
    const rows: string[] = [];
    const range = typeof sheet?.["!ref"] === "string" ? sheet["!ref"] : undefined;
    if (sheet !== undefined && range !== undefined) {
      const decoded = XLSX.utils.decode_range(range);
      const lastRow = Math.min(decoded.e.r, decoded.s.r + 79);
      const lastColumn = Math.min(decoded.e.c, decoded.s.c + 29);
      for (let rowIndex = decoded.s.r; rowIndex <= lastRow; rowIndex += 1) {
        const cells: string[] = [];
        for (let colIndex = decoded.s.c; colIndex <= lastColumn; colIndex += 1) {
          const address = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
          const cell = sheet[address] as SheetJsPreviewCell | undefined;
          cells.push(`<td>${escapeHtml(sheetJsPreviewCellText(cell))}</td>`);
        }
        rows.push(`<tr>${cells.join("")}</tr>`);
      }
    }
    tables.push(
      `<h2>${escapeHtml(workbookPreviewSheetName(sheetName, sheetIndex))}</h2><table>${rows.join("")}</table>`,
    );
  }
  return tables.join("\n");
}

function renderPresentationPreviewHtml(
  slides: readonly { readonly content: SlidePreviewContent }[],
): string {
  const cards = slides
    .slice(0, 12)
    .map((slide, index) => {
      const body = slidePreviewBody(slide.content);
      return `<section class="slide-card"><div class="slide-meta">Slide ${String(index + 1)}</div><h2>${escapeHtml(slide.content.title)}</h2>${body}</section>`;
    })
    .join("");
  return `<div class="slide-preview">${cards}</div>`;
}

function slidePreviewBody(content: SlidePreviewContent): string {
  const items = content.items ?? [];
  if (items.length > 0) {
    return `<ul>${items
      .slice(0, 12)
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("")}</ul>`;
  }
  const subtitle = typeof content.subtitle === "string" ? content.subtitle.trim() : "";
  if (subtitle.length > 0) {
    return `<p>${escapeHtml(subtitle)}</p>`;
  }
  const note = typeof content.note === "string" ? content.note.trim() : "";
  if (note.length > 0) {
    return `<p>${escapeHtml(note)}</p>`;
  }
  return "";
}

async function renderOfficePreviewPdfWithChromium(input: {
  readonly html: string;
  readonly filename: string;
  readonly executablePath?: string | undefined;
  readonly timeoutMs: number;
}): Promise<Uint8Array> {
  const { chromium } = await import("playwright");
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-web-security", "--no-sandbox"],
      ...(input.executablePath === undefined ? {} : { executablePath: input.executablePath }),
    });
    const page = await browser.newPage();
    await page.setContent(input.html, { waitUntil: "load", timeout: input.timeoutMs });
    const pdf = await page.pdf({
      format: "Letter",
      margin: { top: "0.35in", right: "0.35in", bottom: "0.35in", left: "0.35in" },
      printBackground: true,
    });
    return new Uint8Array(pdf);
  } catch (error) {
    throw new Error(
      `Local Office preview PDF rendering failed for ${input.filename}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

type OfficePreviewKind = "document" | "spreadsheet" | "presentation";

function officePreviewKind(mimeType: string, filename: string): OfficePreviewKind | null {
  const mime = mimeType.toLowerCase();
  const name = filename.toLowerCase();
  if (mime.includes("wordprocessingml") || /\.(docx|docm|dotx|dotm)$/iu.test(name)) {
    return "document";
  }
  if (
    mime.includes("spreadsheetml") ||
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.oasis.opendocument.spreadsheet" ||
    /\.(xlsx|xlsm|xltx|xltm|xls|xlsb|ods)$/iu.test(name)
  ) {
    return "spreadsheet";
  }
  if (mime.includes("presentationml") || /\.(pptx|pptm|ppsx|ppsm|potx|potm)$/iu.test(name)) {
    return "presentation";
  }
  return null;
}

function wrapOfficePreview(filename: string, body: string, warnings: readonly string[]): string {
  const safeName = escapeHtml(filename);
  const warningList =
    warnings.length === 0
      ? ""
      : `<ul class="warnings">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeName}</title>
<style>${officePreviewCss}</style>
</head>
<body>
  <header><h1>${safeName}</h1><small>Helix Drive preview</small></header>
  <main><div class="doc">${body}</div>${warningList}</main>
</body>
</html>`;
}

interface SheetJsPreviewCell {
  readonly t?: string;
  readonly v?: unknown;
  readonly f?: string;
  readonly w?: string;
}

interface SlidePreviewContent {
  readonly layout: string;
  readonly title: string;
  readonly items?: readonly string[];
  readonly subtitle?: string;
  readonly note?: string;
}

function sheetJsPreviewCellText(cell: SheetJsPreviewCell | undefined): string {
  if (cell === undefined) {
    return "";
  }
  if (typeof cell.f === "string" && cell.f.length > 0) {
    const formula = sanitizeWorkbookPreviewText(cell.f);
    return formula.length > 0 ? `=${formula}` : "";
  }
  if (cell.v instanceof Date) {
    return cell.v.toISOString();
  }
  if (
    typeof cell.v === "string" ||
    typeof cell.v === "number" ||
    typeof cell.v === "boolean" ||
    typeof cell.v === "bigint"
  ) {
    return sanitizeWorkbookPreviewText(String(cell.v));
  }
  if (cell.t === "e" && typeof cell.w === "string") {
    return sanitizeWorkbookPreviewText(cell.w);
  }
  return "";
}

function workbookPreviewSheetName(rawName: string, index: number): string {
  const fallback = `Sheet ${String(index + 1)}`;
  if (hasWorkbookPreviewControlCharacter(rawName)) {
    return fallback;
  }
  return sanitizeWorkbookPreviewText(rawName).trim().slice(0, 120) || fallback;
}

function hasWorkbookPreviewControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function sanitizeWorkbookPreviewText(value: string): string {
  let sanitized = "";
  for (const char of value) {
    if (!isWorkbookPreviewControlCharacter(char)) {
      sanitized += char;
    }
  }
  return sanitized;
}

function isWorkbookPreviewControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    (code >= 0x7f && code <= 0x9f)
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

const officePreviewCss = `
body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2937;background:#f8fafc}
header{position:sticky;top:0;z-index:1;background:#fff;border-bottom:1px solid #e5e7eb;padding:12px 18px}
h1{font-size:16px;line-height:1.3;margin:0;font-weight:650}
small{color:#6b7280}
main{padding:18px}
.doc{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:22px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
table{border-collapse:collapse;width:100%;margin:12px 0 24px;font-size:12px}
td,th{border:1px solid #e5e7eb;padding:5px 7px;vertical-align:top}
h2{font-size:15px;margin:18px 0 8px}
.slide-preview{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.slide-card{aspect-ratio:16/9;border:1px solid #d1d5db;border-radius:8px;background:#fff;padding:18px;overflow:hidden}
.slide-meta{font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.08em}
.slide-card h2{font-size:20px;margin:10px 0}
.slide-card li,.slide-card p{font-size:13px}
.warnings{margin:16px 0 0;color:#92400e}
`;

function isConversionResponse(value: unknown): value is {
  readonly pdfBase64: string;
  readonly pageCount?: number;
  readonly generatedAt?: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pdfBase64 === "string" &&
    (candidate.pageCount === undefined ||
      (typeof candidate.pageCount === "number" && Number.isFinite(candidate.pageCount))) &&
    (candidate.generatedAt === undefined || typeof candidate.generatedAt === "string")
  );
}
