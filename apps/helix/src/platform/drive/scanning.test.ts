import type postgres from "postgres";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "../../config/env.js";
import {
  createNoopVirusScanner,
  assertArchiveWithinLimits,
  createClamAvVirusScanner,
  resolveEffectiveMime,
  sniffMimeType,
} from "./scanning.js";
import { PostgresDriveStore } from "./store.js";

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

  it("cannot back a production Drive store", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgres://test:test@localhost/test");
    resetEnvCacheForTests();
    const sql = (() => Promise.resolve([])) as unknown as postgres.Sql;
    expect(() => new PostgresDriveStore(sql)).toThrow("antivirus scanner is required");
  });

  it("cannot back an explicitly secure Drive store outside production", () => {
    const sql = (() => Promise.resolve([])) as unknown as postgres.Sql;
    expect(() => new PostgresDriveStore(sql, undefined, { requireVirusScanner: true })).toThrow(
      "antivirus scanner is required",
    );
  });
});

describe("archive scan limits", () => {
  it("quarantines files above the scanner size policy without contacting clamd", async () => {
    await expect(
      createClamAvVirusScanner({ host: "127.0.0.1", port: 1, maxFileBytes: 3 }).scan(
        Buffer.from("four"),
      ),
    ).resolves.toEqual({ clean: false, signature: "Heuristics.Limits.Exceeded" });
  });

  it("blocks high-ratio ZIP bombs before opening a clamd connection", async () => {
    const zip = new JSZip();
    zip.file("bomb.txt", Buffer.alloc(1024 * 1024));
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    expect(() => {
      assertArchiveWithinLimits(bytes, {
        maxEntries: 10,
        maxUncompressedBytes: 2 * 1024 * 1024,
        maxExpansionRatio: 10,
        maxNestedArchives: 1,
      });
    }).toThrow("decompression limits");
    await expect(
      createClamAvVirusScanner({
        host: "127.0.0.1",
        port: 1,
        archiveLimits: { maxExpansionRatio: 10 },
      }).scan(bytes),
    ).resolves.toEqual({ clean: false, signature: "Heuristics.ArchiveBomb" });
  });

  it("rejects malformed ZIP metadata instead of passing it to the scanner", () => {
    expect(() => {
      assertArchiveWithinLimits(Buffer.from("PK\u0003\u0004broken"));
    }).toThrow("central directory");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
});
