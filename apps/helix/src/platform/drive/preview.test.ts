import { describe, expect, it, vi } from "vitest";
import {
  assertPreviewUrlAllowed,
  createIsolatedContentConverter,
  officePreviewStorageKey,
} from "./preview.js";
import { DriveForbiddenError } from "./errors.js";

const officeInput = {
  objectId: "object-1",
  name: "Q3 deck.pptx",
  storageKey: "drive/org/object/v1/Q3_deck.pptx",
  sourceMimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  content: new TextEncoder().encode("pptx bytes"),
};

describe("assertPreviewUrlAllowed", () => {
  it("rejects a link-local metadata host", () => {
    expect(() => {
      assertPreviewUrlAllowed("http://169.254.169.254/latest/meta-data", ["converter.internal"]);
    }).toThrow(DriveForbiddenError);
  });

  it("permits the explicitly allowlisted converter host", () => {
    expect(() => {
      assertPreviewUrlAllowed("http://converter.internal:8080/convert", ["converter.internal"]);
    }).not.toThrow();
  });

  it("rejects a non-allowlisted host", () => {
    expect(() => {
      assertPreviewUrlAllowed("http://evil.example/convert", ["converter.internal"]);
    }).toThrow(/not allowlisted/iu);
  });
});

describe("isolated content converter client", () => {
  it("posts bounded Office bytes and validates the PDF response", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const client = createIsolatedContentConverter({
      endpoint: "https://converter.example:8080",
      fetch: async (url, init) => {
        requests.push({ url: requestUrl(url), init: init ?? {} });
        return conversionResponse();
      },
    });

    const result = await client.convert(officeInput);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://converter.example:8080/convert/office-to-pdf",
      init: { method: "POST" },
    });
    expect(requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(requests[0]?.init.body as string)).toEqual({
      name: "Q3 deck.pptx",
      mimeType: officeInput.sourceMimeType,
      contentBase64: Buffer.from("pptx bytes").toString("base64"),
    });
    expect(new TextDecoder().decode(result.pdf)).toBe("%PDF-1.7\n");
    expect(result).toMatchObject({ pageCount: 2, generatedAt: "2026-05-20T12:00:01.000Z" });
  });

  it("uses the same isolated service for sanitized HTML-to-PDF rendering", async () => {
    let request: { readonly url: string; readonly body: Record<string, unknown> } | undefined;
    const client = createIsolatedContentConverter({
      endpoint: "https://converter.example:8080",
      fetch: async (url, init) => {
        request = {
          url: requestUrl(url),
          body: JSON.parse(init?.body as string) as Record<string, unknown>,
        };
        return conversionResponse();
      },
    });

    await client.renderHtml({ name: "Board packet.html", html: "<h1>Board packet</h1>" });

    expect(request).toEqual({
      url: "https://converter.example:8080/convert/html-to-pdf",
      body: {
        name: "Board packet.html",
        mimeType: "text/html",
        contentBase64: Buffer.from("<h1>Board packet</h1>").toString("base64"),
      },
    });
  });

  it("extracts bounded Office text in the worker", async () => {
    const client = createIsolatedContentConverter({
      endpoint: "https://converter.example:8080",
      fetch: async (url) => {
        expect(requestUrl(url)).toBe("https://converter.example:8080/convert/office-to-text");
        return Response.json({
          textBase64: Buffer.from("Quarterly plan", "utf8").toString("base64"),
          pageCount: 2,
          generatedAt: "2026-05-20T12:00:01.000Z",
        });
      },
    });

    await expect(
      client.extractText({
        name: officeInput.name,
        mimeType: officeInput.sourceMimeType,
        content: officeInput.content,
      }),
    ).resolves.toMatchObject({ text: "Quarterly plan", pageCount: 2 });
  });

  it("rejects oversized input before making a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createIsolatedContentConverter({
      endpoint: "https://converter.example:8080",
      fetch,
      maxInputBytes: 4,
    });

    await expect(client.convert(officeInput)).rejects.toThrow("between 1 and 4 bytes");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid artifacts and page-limit violations", async () => {
    const bodies = [
      { pdfBase64: Buffer.from("not a PDF").toString("base64"), pageCount: 1 },
      { pdfBase64: Buffer.from("%PDF-1.7\n").toString("base64"), pageCount: 3 },
    ];
    for (const body of bodies) {
      const client = createIsolatedContentConverter({
        endpoint: "https://converter.example:8080",
        maxPages: 2,
        fetch: async () => Response.json({ ...body, generatedAt: "2026-05-20T12:00:01.000Z" }),
      });
      await expect(client.convert(officeInput)).rejects.toThrow(/invalid/iu);
    }
  });

  it("aborts a converter request at the configured deadline", async () => {
    const client = createIsolatedContentConverter({
      endpoint: "https://converter.example:8080",
      timeoutMs: 5,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Timed out", "TimeoutError"));
            },
            { once: true },
          );
        }),
    });

    await expect(client.convert(officeInput)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("creates version-scoped preview storage keys", () => {
    expect(officePreviewStorageKey("org-1", "object-1", 3)).toMatch(
      /^drive-previews\/org-1\/object-1\/v3\/[0-9a-f-]+\.pdf$/u,
    );
  });
});

function conversionResponse(): Response {
  return Response.json({
    pdfBase64: Buffer.from("%PDF-1.7\n").toString("base64"),
    pageCount: 2,
    generatedAt: "2026-05-20T12:00:01.000Z",
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
