import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { detectDlp, MAX_DLP_SCAN_BYTES } from "../../dlp.js";
import { inspectAndScanUpload } from "./scan-content.js";

describe("streamed upload content for DLP", () => {
  it("retains the complete bounded content, including credentials split across chunks", async () => {
    const chunks = [Buffer.from("api_"), Buffer.from("key=real_secret_value_here")];
    const content = Buffer.concat(chunks);
    const scanner = {
      scan: vi.fn(async () => ({ clean: true as const })),
      scanStream: vi.fn(async () => ({ clean: true as const })),
    };
    const result = await inspectAndScanUpload({
      open: async () => Readable.from(chunks),
      declaredByteSize: content.length,
      declaredMimeType: "text/plain",
      scanner,
    });
    expect(Buffer.from(result.bufferedBytes ?? [])).toEqual(content);
    expect(
      detectDlp(Buffer.from(result.bufferedBytes ?? []).toString(), new Set(["credentials"])),
    ).toEqual([{ detector: "credentials", classification: "restricted" }]);
    expect(scanner.scan).toHaveBeenCalledWith(content);
    expect(scanner.scanStream).not.toHaveBeenCalled();
  });

  it("keeps large uploads streaming and reports no complete DLP buffer", async () => {
    const content = Buffer.alloc(MAX_DLP_SCAN_BYTES + 1, 97);
    const scanner = {
      scan: vi.fn(async () => ({ clean: true as const })),
      scanStream: vi.fn(async () => ({ clean: true as const })),
    };
    const result = await inspectAndScanUpload({
      open: async () => Readable.from([content]),
      declaredByteSize: content.length,
      declaredMimeType: "text/plain",
      scanner,
    });
    expect(result.bufferedBytes).toBeUndefined();
    expect(scanner.scanStream).toHaveBeenCalledOnce();
    expect(scanner.scan).not.toHaveBeenCalled();
  });
});
