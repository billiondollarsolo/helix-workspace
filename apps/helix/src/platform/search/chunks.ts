import { createHash } from "node:crypto";
import type { JsonObject } from "@helix/sdk-types";
import type { IndexDocument } from "./types.js";

export function retrievalChunkSettings(config: JsonObject = {}) {
  const size = config.maxInputChars ?? 1024;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 64 || size > 32768)
    throw new TypeError("Chunk size must be an integer from 64 to 32768 characters.");
  const overlap = config.chunkOverlapChars ?? Math.floor(size * 0.15);
  if (typeof overlap !== "number" || !Number.isInteger(overlap) || overlap < 0 || overlap >= size)
    throw new TypeError("Chunk overlap must be a non-negative integer smaller than chunk size.");
  return { size, overlap };
}

export function documentText(document: IndexDocument): string {
  return [document.title, document.body]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
}

function sourceHash(document: IndexDocument): string {
  return createHash("sha256").update(documentText(document)).digest("hex");
}

/** Bounded overlapping passages, preserving exact source offsets for authoritative reloads. */
export function chunkDocument(
  document: IndexDocument,
  settings: { size: number; overlap: number },
) {
  const text = documentText(document);
  const hash = sourceHash(document);
  const chunks: { text: string; start: number; end: number }[] = [];
  let start = 0;
  while (start < text.length) {
    if (chunks.length === 2048)
      throw new TypeError("Document exceeds 2048 chunks. Increase chunk size or split the source.");
    let end = Math.min(start + settings.size, text.length);
    if (end < text.length) {
      // Prefer a paragraph/word boundary, but always advance even for unbroken code or URLs.
      const boundary = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(" ", end));
      if (boundary > start + Math.max(settings.overlap, Math.floor(settings.size / 2)))
        end = boundary;
      if (/[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
    }
    chunks.push({ text: text.slice(start, end), start, end });
    if (end === text.length) break;
    start = Math.max(start + 1, end - settings.overlap);
    if (/[\uDC00-\uDFFF]/u.test(text[start] ?? "")) start++;
  }
  return chunks.map((chunk, index) => ({
    id: `${document.id}:chunk:${String(index)}`,
    text: chunk.text,
    document: {
      ...document,
      body: chunk.text,
      attributes: {
        ...document.attributes,
        chunkIndex: index,
        chunkCount: chunks.length,
        chunkStart: chunk.start,
        chunkEnd: chunk.end,
        sourceHash: hash,
      },
    },
  }));
}

/** Stale embeddings cannot reintroduce old text after an edit or change of ownership. */
export function hydrateChunk(
  document: IndexDocument,
  attributes: JsonObject | undefined,
): IndexDocument | null {
  if (attributes?.chunkIndex === undefined) return document;
  const start = attributes.chunkStart,
    end = attributes.chunkEnd;
  const text = documentText(document);
  if (
    attributes.sourceHash !== sourceHash(document) ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > text.length
  )
    return null;
  return {
    ...document,
    body: text.slice(start, end),
    attributes: {
      ...document.attributes,
      chunkIndex: attributes.chunkIndex,
      chunkCount: attributes.chunkCount ?? 1,
      chunkStart: start,
      chunkEnd: end,
      sourceHash: attributes.sourceHash,
    },
  };
}
