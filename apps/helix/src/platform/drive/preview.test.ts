import { describe, expect, it } from "vitest";
import { createLibreOfficePreviewClient, officePreviewStorageKey } from "./preview.js";

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

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}
