import { randomUUID } from "node:crypto";

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
}

export function createLibreOfficePreviewClient(
  options: LibreOfficePreviewClientOptions,
): OfficePreviewConverter {
  return new LibreOfficePreviewClient(options);
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

  constructor(options: LibreOfficePreviewClientOptions) {
    this.#endpoint = new URL(options.endpoint);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async convert(input: OfficePreviewConversionInput): Promise<OfficePreviewConversionResult> {
    const url = new URL("/convert/office-to-pdf", this.#endpoint);
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
