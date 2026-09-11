import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { isTextFile, readSearchText, SEARCH_FILE_BYTES } from "./text-content.js";

it("reads complete UTF-8 text streams and rejects changed, binary or oversized content", async () => {
  const bytes = new TextEncoder().encode("Opening 😀\n".repeat(100) + "Final answer");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const stream = async function* () {
    for (let i = 0; i < bytes.length; i += 5) yield bytes.subarray(i, i + 5);
  };
  expect(await readSearchText(stream(), hash)).toContain("Final answer");
  expect(await readSearchText(bytes, hash)).toBe(new TextDecoder().decode(bytes));
  await expect(readSearchText(bytes, "wrong")).rejects.toThrow("differs from the scanned file");
  const binary = new Uint8Array([0]);
  await expect(
    readSearchText(binary, createHash("sha256").update(binary).digest("hex")),
  ).rejects.toThrow("binary");
  await expect(readSearchText(new Uint8Array([0xff]), hash)).rejects.toThrow();
  await expect(readSearchText(new Uint8Array(SEARCH_FILE_BYTES + 1), hash)).rejects.toThrow(
    "512 KiB",
  );
  for (const [mime, name] of [
    ["text/plain; charset=utf-8", "notes.txt"],
    ["application/json", "data.json"],
    ["application/octet-stream", "script.py"],
  ])
    expect(isTextFile(mime ?? "", name ?? "")).toBe(true);
  expect(isTextFile("application/pdf", "report.pdf")).toBe(false);
  expect(isTextFile("application/octet-stream", "data.bin")).toBe(false);
});
