import { randomUUID } from "node:crypto";
import { assertOutboundHttpUrl, createOutboundHttpClient } from "../outbound-http.js";
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
  readonly pageCount: number;
  readonly generatedAt: string;
}

export interface OfficePreviewConverter {
  convert(input: OfficePreviewConversionInput): Promise<OfficePreviewConversionResult>;
}

export interface OfficeTextExtractionInput {
  readonly name: string;
  readonly mimeType: string;
  readonly content: Uint8Array;
}

export interface OfficeTextExtractionResult {
  readonly text: string;
  readonly pageCount: number;
  readonly generatedAt: string;
}

export interface IsolatedContentConverter extends OfficePreviewConverter {
  renderHtml(input: {
    readonly name: string;
    readonly html: string;
  }): Promise<OfficePreviewConversionResult>;
  extractText(input: OfficeTextExtractionInput): Promise<OfficeTextExtractionResult>;
}

export interface IsolatedContentConverterOptions {
  readonly endpoint: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxTextBytes?: number;
  readonly maxPages?: number;
  /** When non-empty, only these hostnames may be contacted (SSRF guard). */
  readonly allowedHosts?: readonly string[];
}

const DEFAULT_MAX_INPUT_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 200;

/** Rejects unsafe or unexpected converter endpoints before any request is sent. */
export function assertPreviewUrlAllowed(url: string, allowedHosts: readonly string[] = []): void {
  try {
    assertOutboundHttpUrl(url, {
      production: true,
      allowHttp: allowedHosts.length > 0,
      allowPrivateNetwork: allowedHosts.length > 0,
      allowedHosts,
    });
  } catch {
    throw new DriveForbiddenError("Content converter URL is not allowlisted by outbound policy.");
  }
}

export function createIsolatedContentConverter(
  options: IsolatedContentConverterOptions,
): IsolatedContentConverter {
  return new HttpContentConverter(options);
}

export function officePreviewStorageKey(
  orgId: string,
  objectId: string,
  versionNumber: number,
): string {
  return `drive-previews/${orgId}/${objectId}/v${String(versionNumber)}/${randomUUID()}.pdf`;
}

class HttpContentConverter implements IsolatedContentConverter {
  readonly #endpoint: URL;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxInputBytes: number;
  readonly #maxOutputBytes: number;
  readonly #maxTextBytes: number;
  readonly #maxPages: number;
  readonly #allowedHosts: readonly string[];

  constructor(options: IsolatedContentConverterOptions) {
    this.#endpoint = new URL(options.endpoint);
    this.#timeoutMs = positiveLimit(options.timeoutMs, 30_000, "timeoutMs");
    this.#maxInputBytes = positiveLimit(
      options.maxInputBytes,
      DEFAULT_MAX_INPUT_BYTES,
      "maxInputBytes",
    );
    this.#maxOutputBytes = positiveLimit(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    this.#maxTextBytes = positiveLimit(
      options.maxTextBytes,
      DEFAULT_MAX_TEXT_BYTES,
      "maxTextBytes",
    );
    this.#maxPages = positiveLimit(options.maxPages, DEFAULT_MAX_PAGES, "maxPages");
    this.#allowedHosts = options.allowedHosts ?? [];
    assertPreviewUrlAllowed(this.#endpoint.toString(), this.#allowedHosts);
    this.#fetch =
      options.fetch ??
      createOutboundHttpClient({
        production: true,
        allowHttp: this.#allowedHosts.length > 0,
        allowPrivateNetwork: this.#allowedHosts.length > 0,
        allowedHosts: this.#allowedHosts,
        timeoutMs: this.#timeoutMs,
        maxRequestBytes: Math.ceil((this.#maxInputBytes * 4) / 3) + 8_192,
        maxResponseBytes:
          Math.ceil((Math.max(this.#maxOutputBytes, this.#maxTextBytes) * 4) / 3) + 8_192,
        maxRedirects: 0,
      });
  }

  async convert(input: OfficePreviewConversionInput): Promise<OfficePreviewConversionResult> {
    return this.#convert("/convert/office-to-pdf", {
      name: input.name,
      mimeType: input.sourceMimeType,
      content: input.content,
    });
  }

  async renderHtml(input: {
    readonly name: string;
    readonly html: string;
  }): Promise<OfficePreviewConversionResult> {
    return this.#convert("/convert/html-to-pdf", {
      name: input.name,
      mimeType: "text/html",
      content: Buffer.from(input.html, "utf8"),
    });
  }

  async extractText(input: OfficeTextExtractionInput): Promise<OfficeTextExtractionResult> {
    const body = await this.#request(
      "/convert/office-to-text",
      input,
      Math.ceil((this.#maxTextBytes * 4) / 3) + 8_192,
    );
    if (!isTextResponse(body, this.#maxPages)) {
      throw new Error("Content converter returned an invalid response.");
    }
    const text = decodeText(body.textBase64, this.#maxTextBytes);
    return { text, pageCount: body.pageCount, generatedAt: body.generatedAt };
  }

  async #convert(
    path: string,
    input: { readonly name: string; readonly mimeType: string; readonly content: Uint8Array },
  ): Promise<OfficePreviewConversionResult> {
    const body = await this.#request(
      path,
      input,
      Math.ceil((this.#maxOutputBytes * 4) / 3) + 8_192,
    );
    if (!isPdfResponse(body, this.#maxPages)) {
      throw new Error("Content converter returned an invalid response.");
    }
    const pdf = decodePdf(body.pdfBase64, this.#maxOutputBytes);
    return { pdf, pageCount: body.pageCount, generatedAt: body.generatedAt };
  }

  async #request(
    path: string,
    input: { readonly name: string; readonly mimeType: string; readonly content: Uint8Array },
    maxResponseBytes: number,
  ): Promise<unknown> {
    if (input.content.byteLength === 0 || input.content.byteLength > this.#maxInputBytes) {
      throw new Error(
        `Content conversion input must be between 1 and ${String(this.#maxInputBytes)} bytes.`,
      );
    }
    const url = new URL(path, this.#endpoint);
    assertPreviewUrlAllowed(url.toString(), this.#allowedHosts);
    const response = await this.#fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(this.#timeoutMs),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        mimeType: input.mimeType,
        contentBase64: Buffer.from(input.content).toString("base64"),
      }),
    });
    if (!response.ok) {
      throw new Error(`Content conversion failed with HTTP ${String(response.status)}.`);
    }

    const raw = await readBoundedResponse(response, maxResponseBytes);
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Error("Content converter returned invalid JSON.");
    }
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return resolved;
}

async function readBoundedResponse(response: Response, limit: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result: unknown = await reader.read();
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error("Content converter returned an invalid response stream.");
    }
    const chunk = result as Record<string, unknown>;
    if (chunk.done === true) break;
    if (chunk.done !== false || !(chunk.value instanceof Uint8Array)) {
      throw new Error("Content converter returned an invalid response stream.");
    }
    const value = chunk.value;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Content converter response exceeds the configured byte limit.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

function decodePdf(base64: string, maxBytes: number): Buffer {
  if (!isCanonicalBase64(base64)) {
    throw new Error("Content converter returned invalid PDF encoding.");
  }
  const pdf = Buffer.from(base64, "base64");
  if (
    pdf.byteLength === 0 ||
    pdf.byteLength > maxBytes ||
    !pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))
  ) {
    throw new Error("Content converter returned an invalid PDF artifact.");
  }
  return pdf;
}

function decodeText(base64: string, maxBytes: number): string {
  if (!isCanonicalBase64(base64)) {
    throw new Error("Content converter returned invalid text encoding.");
  }
  const text = Buffer.from(base64, "base64");
  if (text.byteLength === 0 || text.byteLength > maxBytes) {
    throw new Error("Content converter returned an invalid text artifact.");
  }
  return text.toString("utf8");
}

function isCanonicalBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  );
}

function isPdfResponse(
  value: unknown,
  maxPages: number,
): value is {
  readonly pdfBase64: string;
  readonly pageCount: number;
  readonly generatedAt: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pdfBase64 === "string" &&
    typeof candidate.pageCount === "number" &&
    Number.isSafeInteger(candidate.pageCount) &&
    candidate.pageCount > 0 &&
    candidate.pageCount <= maxPages &&
    typeof candidate.generatedAt === "string" &&
    Number.isFinite(Date.parse(candidate.generatedAt))
  );
}

function isTextResponse(
  value: unknown,
  maxPages: number,
): value is {
  readonly textBase64: string;
  readonly pageCount: number;
  readonly generatedAt: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.textBase64 === "string" &&
    typeof candidate.pageCount === "number" &&
    Number.isSafeInteger(candidate.pageCount) &&
    candidate.pageCount > 0 &&
    candidate.pageCount <= maxPages &&
    typeof candidate.generatedAt === "string" &&
    Number.isFinite(Date.parse(candidate.generatedAt))
  );
}
