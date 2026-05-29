/* Convert-on-click: when a Drive blob isn't already a native helix-doc/
 * sheet/deck, eagerly create the native counterpart by calling the matching
 * server-side import tool, then redirect to it. This is the "open with
 * helix-docs" / "open with helix-sheets" / "open with helix-slides" pattern
 * that Google Drive uses for foreign-format files.
 *
 * Result: user clicks a .docx → universal loader sees no native doc → calls
 * docs.import-docx → gets back a fresh helix-doc id → caller navigates to
 * /docs/<id> → the full native shell loads with the imported content,
 * complete with comments, suggestions, versions, AI panel, ribbon, menu bar,
 * collaboration, etc. The original Drive blob stays untouched.
 *
 * Server-side import tools are preferred over client-side parse → create
 * because the server already validates, classifies, scans, and audits. We
 * fall back to client-side parse + docs.create for formats without a
 * dedicated server importer (markdown/txt/html/rtf/odt/eml/odp).
 */

import {
  importDocxDocument,
  createDocsDocument,
  migrateDocsDocumentToNative,
} from "@/features/docs/api";
import {
  importCsvSheet,
  importOdsSheet,
  importTsvSheet,
  importXlsxSheet,
} from "@/features/sheets/api";
import { importPptxDeck } from "@/features/slides/api";
import type { DriveBlob } from "./drive-fetcher.js";
import type { FormatDescriptor } from "./format-detection.js";
import type { ImportedDeck, ImportedDoc, ImportedSheet, TiptapNode } from "./parsers/types.js";

export interface ConvertedTarget {
  readonly surface: "docs" | "sheets" | "slides";
  /** New native helix entity id to navigate to. */
  readonly id: string;
}

/** Convert a parsed imported doc into a native helix-doc via the matching
 *  server-side tool. Returns the new native document id. */
export async function convertImportedDocToNative(
  blob: DriveBlob,
  parsed: ImportedDoc,
  sourceObjectId: string,
): Promise<ConvertedTarget> {
  const metadata = importedFromMetadata(blob, parsed.format, sourceObjectId);
  const title = titleFromFilename(blob.name);

  let createdId: string;
  if (parsed.format.id === "docx") {
    // Server tool exists for DOCX — it runs through the canonical converter,
    // classifier, virus scanner.
    const created = await importDocxDocument({
      filename: blob.name,
      title,
      contentBase64: arrayBufferToBase64(blob.bytes),
      metadata,
    });
    createdId = created.id;
  } else {
    // Other formats (md/txt/html/rtf/odt/eml): hydrate via docs.create with
    // markdown serialized from the parsed TipTap doc.
    const markdown = tiptapDocToMarkdown(parsed.tiptapDoc);
    const created = await createDocsDocument({
      title,
      initialMarkdown: markdown,
      metadata,
    });
    createdId = created.id;
  }

  // The native docs editor mounts an editor *session* via
  // `/api/editors/documents/<id>`, which is created lazily. Calling
  // docs.migrate-native here forces session creation now so the editor
  // doesn't race-404 on first mount after the redirect. Failure is
  // tolerated — the editor will retry on its own and may resolve.
  await migrateDocsDocumentToNative({ docId: createdId }).catch(() => undefined);

  return { surface: "docs", id: createdId };
}

/** Convert a parsed imported sheet into a native helix-sheet. */
export async function convertImportedSheetToNative(
  blob: DriveBlob,
  parsed: ImportedSheet,
  sourceObjectId: string,
): Promise<ConvertedTarget> {
  const metadata = importedFromMetadata(blob, parsed.format, sourceObjectId);
  const title = titleFromFilename(blob.name);
  const contentBase64 = arrayBufferToBase64(blob.bytes);

  if (blob.name.toLowerCase().endsWith(".ods")) {
    const result = await importOdsSheet({
      filename: blob.name,
      title,
      contentBase64,
      metadata,
    });
    return { surface: "sheets", id: result.id };
  }
  // XLSX / XLS / XLSB: server can ingest the raw OOXML/BIFF directly via
  // sheets.import-xlsx (SheetJS server-side too).
  if (parsed.format.id === "xlsx" || blob.name.toLowerCase().endsWith(".xlsx")) {
    const result = await importXlsxSheet({
      filename: blob.name,
      title,
      contentBase64,
      metadata,
    });
    return { surface: "sheets", id: result.id };
  }
  if (parsed.format.id === "tsv" || blob.name.toLowerCase().endsWith(".tsv")) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(blob.bytes);
    const result = await importTsvSheet({ filename: blob.name, title, tsvText: text, metadata });
    return { surface: "sheets", id: result.id };
  }
  // CSV (default for sheet-flavored text)
  const text = new TextDecoder("utf-8", { fatal: false }).decode(blob.bytes);
  const result = await importCsvSheet({ filename: blob.name, title, csvText: text, metadata });
  return { surface: "sheets", id: result.id };
}

/** Convert a parsed imported deck into a native helix-deck. */
export async function convertImportedDeckToNative(
  blob: DriveBlob,
  parsed: ImportedDeck,
  sourceObjectId: string,
): Promise<ConvertedTarget> {
  const metadata = importedFromMetadata(blob, parsed.format, sourceObjectId);
  const title = titleFromFilename(blob.name);

  // PPTX: server import path (preferred — full fidelity through engine-slide
  // server-side once that's implemented; today the server's slides.import-pptx
  // does a text-only extraction similar to our client parser).
  if (parsed.format.id === "pptx" || blob.name.toLowerCase().endsWith(".pptx")) {
    const result = await importPptxDeck({
      filename: blob.name,
      title,
      contentBase64: arrayBufferToBase64(blob.bytes),
      metadata,
    });
    return { surface: "slides", id: result.id };
  }

  // ODP: no server tool yet — TODO. For v1, throw so the loader falls back
  // to the read-only ImportedDeckRenderer.
  throw new ConverterNotAvailableError(
    `Server-side import tool not yet available for ${parsed.format.label}. ` +
      `Use the read-only viewer for now.`,
  );
}

export class ConverterNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConverterNotAvailableError";
  }
}

function importedFromMetadata(
  blob: DriveBlob,
  format: FormatDescriptor,
  sourceObjectId: string,
): Record<string, unknown> {
  const sourceFormat = sourceFormatFromFilename(blob.name) ?? format.id;
  return {
    importedFromDriveObjectId: sourceObjectId,
    importedFromFilename: blob.name,
    importedFromFormat: sourceFormat,
    importedFromFormatLabel: format.label,
    importedFromMimeType: blob.mimeType,
    importedFromByteSize: blob.byteLength,
    importedAt: new Date().toISOString(),
  };
}

function sourceFormatFromFilename(name: string): string | null {
  const extension = /\.([^.\\/]+)$/u.exec(name.trim())?.[1]?.toLowerCase();
  return extension === undefined || extension.length === 0 ? null : extension;
}

function titleFromFilename(name: string): string {
  return (
    name
      .replace(/^.*[\\/]/, "")
      .replace(/\.[^.]+$/, "")
      .trim() || "Imported document"
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Minimal TipTap doc → markdown serializer. Handles paragraphs, headings,
 *  lists, blockquotes, code blocks, horizontal rules, and inline emphasis /
 *  strong / inline code / links. Sufficient round-trip for the parsers in
 *  this package that produce ImportedDoc results. */
function tiptapDocToMarkdown(doc: TiptapNode): string {
  if (doc.type !== "doc") return "";
  const out: string[] = [];
  for (const block of doc.content ?? []) {
    out.push(blockToMarkdown(block));
  }
  return out.filter((s) => s.length > 0).join("\n\n");
}

function blockToMarkdown(node: TiptapNode): string {
  switch (node.type) {
    case "paragraph":
      return inlinesToMarkdown(node.content ?? []);
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      return "#".repeat(level) + " " + inlinesToMarkdown(node.content ?? []);
    }
    case "bulletList":
      return (node.content ?? [])
        .map((li) => "- " + inlinesToMarkdown((li.content?.[0]?.content ?? []) as TiptapNode[]))
        .join("\n");
    case "orderedList":
      return (node.content ?? [])
        .map(
          (li, idx) =>
            `${idx + 1}. ` + inlinesToMarkdown((li.content?.[0]?.content ?? []) as TiptapNode[]),
        )
        .join("\n");
    case "blockquote":
      return (node.content ?? [])
        .map((inner) => "> " + blockToMarkdown(inner).replace(/\n/g, "\n> "))
        .join("\n");
    case "codeBlock": {
      const text = (node.content ?? []).map((c) => c.text ?? "").join("");
      const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      return "```" + lang + "\n" + text + "\n```";
    }
    case "horizontalRule":
      return "---";
    case "table":
      return tableToMarkdown(node);
    default:
      return inlinesToMarkdown(node.content ?? []);
  }
}

function tableToMarkdown(table: TiptapNode): string {
  const rows = (table.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      inlinesToMarkdown((cell.content?.[0]?.content ?? []) as TiptapNode[]).replace(/\|/g, "\\|"),
    ),
  );
  if (rows.length === 0) return "";
  const cols = rows[0]!.length;
  const lines: string[] = [];
  lines.push("| " + rows[0]!.join(" | ") + " |");
  lines.push("| " + Array(cols).fill("---").join(" | ") + " |");
  for (const row of rows.slice(1)) {
    lines.push("| " + row.join(" | ") + " |");
  }
  return lines.join("\n");
}

function inlinesToMarkdown(nodes: ReadonlyArray<TiptapNode>): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      out += "  \n";
      continue;
    }
    if (node.type !== "text") {
      out += inlinesToMarkdown(node.content ?? []);
      continue;
    }
    let text = node.text ?? "";
    const marks = node.marks ?? [];
    for (const mark of marks) {
      if (mark.type === "bold") text = `**${text}**`;
      else if (mark.type === "italic") text = `*${text}*`;
      else if (mark.type === "code") text = "`" + text + "`";
      else if (mark.type === "strike") text = `~~${text}~~`;
      else if (mark.type === "link") {
        const href = (mark.attrs?.href as string | undefined) ?? "";
        text = `[${text}](${href})`;
      }
    }
    out += text;
  }
  return out;
}
