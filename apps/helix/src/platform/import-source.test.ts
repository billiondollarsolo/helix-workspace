import { describe, expect, it, vi } from "vitest";
import { readImportSource, type ImportSourceReader } from "./import-source.js";

const input = {
  orgId: "00000000-0000-4000-8000-000000000001",
  actorId: "00000000-0000-4000-8000-000000000002",
  objectId: "00000000-0000-4000-8000-000000000003",
};

describe("readImportSource", () => {
  it("rejects an oversized declared object without opening its body", async () => {
    const open = vi.fn();
    const reader = sourceReader({ byteSize: 11, open });

    await expect(readImportSource(reader, { ...input, maxBytes: 10 })).rejects.toThrow(
      "exceeds the 10 byte limit",
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("stops a dishonest storage stream as soon as its aggregate limit is crossed", async () => {
    let chunksRead = 0;
    async function* body() {
      chunksRead += 1;
      yield new Uint8Array(6);
      chunksRead += 1;
      yield new Uint8Array(6);
      chunksRead += 1;
      yield new Uint8Array(6);
    }
    const reader = sourceReader({ byteSize: 5, open: async () => body() });

    await expect(readImportSource(reader, { ...input, maxBytes: 10 })).rejects.toThrow(
      "exceeds the 10 byte limit",
    );
    expect(chunksRead).toBe(2);
  });

  it("returns authorized content with server-owned metadata", async () => {
    const reader = sourceReader({
      byteSize: 3,
      open: async () => new Uint8Array([1, 2, 3]),
    });

    await expect(readImportSource(reader, { ...input, maxBytes: 3 })).resolves.toEqual({
      name: "source.docx",
      mimeType: "application/vnd.example",
      bytes: new Uint8Array([1, 2, 3]),
    });
  });
});

function sourceReader(input: {
  readonly byteSize: number;
  readonly open: () => unknown;
}): ImportSourceReader {
  return {
    openFile: vi.fn(async () => ({
      byteSize: input.byteSize,
      etag: '"etag"',
      entry: { name: "source.docx", mimeType: "application/vnd.example" },
      open: input.open,
    })) as unknown as NonNullable<ImportSourceReader["openFile"]>,
  };
}
