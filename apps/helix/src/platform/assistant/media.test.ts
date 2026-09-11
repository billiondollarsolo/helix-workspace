import { describe, expect, it } from "vitest";
import { extractPdfText, imageMimeType, isImageFile, isPdfFile } from "./media.js";

describe("assistant attachment media", () => {
  it("detects images and PDFs from MIME or extension", () => {
    expect(isImageFile("image/png", "x")).toBe(true);
    expect(isImageFile("application/octet-stream", "photo.JPG")).toBe(true);
    expect(isPdfFile("application/pdf", "x")).toBe(true);
    expect(isPdfFile("application/octet-stream", "report.pdf")).toBe(true);
    expect(isImageFile("application/zip", "photo.png")).toBe(false);
    expect(imageMimeType("image/jpg", "x")).toBe("image/jpeg");
    expect(imageMimeType("application/octet-stream", "shot.webp")).toBe("image/webp");
  });

  it("extracts literal PDF strings", () => {
    const bytes = new TextEncoder().encode("%PDF-1.4\n(BT (Hello Gaithersburg) ET)");
    expect(extractPdfText(bytes)).toContain("Hello Gaithersburg");
  });
});
