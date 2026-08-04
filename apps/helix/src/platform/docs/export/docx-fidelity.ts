import type { DocsExportDocument } from "../types.js";
import { exportDocsDocument, renderPlainText } from "./formats.js";

export interface DocxFidelityFragment {
  readonly label: string;
  readonly text: string;
  readonly required?: boolean | undefined;
}

export interface DocxFidelityConverterResult {
  readonly markdown: string;
  readonly messages?: readonly string[] | undefined;
}

export interface VerifyDocxFidelityInput {
  readonly document: DocsExportDocument;
  readonly includeComments?: boolean | undefined;
  readonly fragments?: readonly DocxFidelityFragment[] | undefined;
  readonly converter?: (input: { readonly buffer: Buffer }) => Promise<DocxFidelityConverterResult>;
}

export interface DocxFidelityReport {
  readonly passed: boolean;
  readonly byteSize: number;
  readonly packageEntries: readonly string[];
  readonly hasCommentsPart: boolean;
  readonly hasCommentsRelationship: boolean;
  readonly hasCommentsContentType: boolean;
  readonly checkedFragments: number;
  readonly matchedFragments: readonly string[];
  readonly missingFragments: readonly string[];
  readonly extractedMarkdown: string;
  readonly converterMessages: readonly string[];
}

export async function verifyDocxExportFidelity(
  input: VerifyDocxFidelityInput,
): Promise<DocxFidelityReport> {
  const exported = exportDocsDocument({
    document: input.document,
    format: "docx",
    includeComments: input.includeComments === true,
  });
  const buffer = Buffer.from(exported.contentBase64, "base64");
  const packageEntries = zipStoreEntries(buffer);
  const contentTypes = packageEntries.find((entry) => entry.name === "[Content_Types].xml");
  const documentRelationships = packageEntries.find(
    (entry) => entry.name === "word/_rels/document.xml.rels",
  );
  const hasCommentsPart = packageEntries.some((entry) => entry.name === "word/comments.xml");
  const hasCommentsRelationship =
    documentRelationships?.text.includes(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
    ) ?? false;
  const hasCommentsContentType =
    contentTypes?.text.includes(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
    ) ?? false;
  const converted = await (input.converter ?? convertDocxWithMammoth)({ buffer });
  const fragments = input.fragments ?? defaultDocxFidelityFragments(input.document);
  const extracted = normalizeFidelityText(converted.markdown);
  const matchedFragments: string[] = [];
  const missingFragments: string[] = [];

  for (const fragment of fragments) {
    const required = fragment.required ?? true;
    const normalized = normalizeFidelityText(fragment.text);
    if (normalized.length === 0) {
      continue;
    }
    if (extracted.includes(normalized)) {
      matchedFragments.push(fragment.label);
    } else if (required) {
      missingFragments.push(fragment.label);
    }
  }

  const commentPartsPresent = hasCommentsPart && hasCommentsRelationship && hasCommentsContentType;

  return {
    passed:
      missingFragments.length === 0 && (input.includeComments !== true || commentPartsPresent),
    byteSize: buffer.byteLength,
    packageEntries: packageEntries.map((entry) => entry.name),
    hasCommentsPart,
    hasCommentsRelationship,
    hasCommentsContentType,
    checkedFragments: fragments.filter((fragment) => fragment.required ?? true).length,
    matchedFragments,
    missingFragments,
    extractedMarkdown: converted.markdown,
    converterMessages: converted.messages ?? [],
  };
}

export function defaultDocxFidelityFragments(
  document: DocsExportDocument,
): readonly DocxFidelityFragment[] {
  return renderPlainText(document, false)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => ({
      label: `line:${String(index + 1)}:${line.slice(0, 48)}`,
      text: line,
      required: true,
    }));
}

interface ZipStoreEntry {
  readonly name: string;
  readonly text: string;
}

function zipStoreEntries(buffer: Buffer): readonly ZipStoreEntry[] {
  const entries: ZipStoreEntry[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.byteLength && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.byteLength) {
      break;
    }
    entries.push({
      name: buffer.subarray(nameStart, nameStart + nameLength).toString("utf8"),
      text: buffer.subarray(dataStart, dataEnd).toString("utf8"),
    });
    offset = dataEnd;
  }
  return entries;
}

interface MammothConverter {
  convertToMarkdown(input: { readonly buffer: Buffer }): Promise<{
    readonly value: string;
    readonly messages?: readonly { readonly message?: string }[];
  }>;
}

async function convertDocxWithMammoth(input: {
  readonly buffer: Buffer;
}): Promise<DocxFidelityConverterResult> {
  const mammothModule = (await import("mammoth")) as unknown as MammothConverter & {
    readonly default?: MammothConverter;
  };
  const mammoth = mammothModule.default ?? mammothModule;
  const result = await mammoth.convertToMarkdown({ buffer: input.buffer });
  return {
    markdown: result.value,
    messages: result.messages?.map((message) => message.message ?? ""),
  };
}

function normalizeFidelityText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/gu, "$1")
    .replace(/\\([.,:;!?])/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}
