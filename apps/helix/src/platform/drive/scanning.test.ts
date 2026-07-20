import { describe, expect, it } from "vitest";
import {
  createNoopVirusScanner,
  resolveEffectiveMime,
  sniffMimeType,
} from "./scanning.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = Buffer.from("%PDF-1.7\n% helix", "utf8");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

describe("sniffMimeType", () => {
  it("detects PNG, PDF, JPEG, and ZIP by magic bytes", () => {
    expect(sniffMimeType(PNG)).toBe("image/png");
    expect(sniffMimeType(PDF)).toBe("application/pdf");
    expect(sniffMimeType(JPEG)).toBe("image/jpeg");
    expect(sniffMimeType(ZIP)).toBe("application/zip");
  });

  it("returns null for unrecognized bytes", () => {
    expect(sniffMimeType(Buffer.from("just text"))).toBeNull();
  });

  it("detects SVG heuristically", () => {
    expect(sniffMimeType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      "image/svg+xml",
    );
  });
});

describe("resolveEffectiveMime", () => {
  it("overrides a client mime that lies about content type", () => {
    expect(resolveEffectiveMime("image/png", "application/pdf")).toBe("application/pdf");
  });

  it("keeps the client mime when the sniff is inconclusive", () => {
    expect(resolveEffectiveMime("text/csv", null)).toBe("text/csv");
  });

  it("keeps OOXML client mime when sniff only sees zip", () => {
    expect(
      resolveEffectiveMime(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/zip",
      ),
    ).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });
});

describe("createNoopVirusScanner", () => {
  it("reports clean", async () => {
    expect(await createNoopVirusScanner().scan(PNG)).toEqual({ clean: true });
  });
});
