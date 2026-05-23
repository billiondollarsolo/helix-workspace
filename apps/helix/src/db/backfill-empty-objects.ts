/* backfill-empty-objects.ts
 *
 * The workspace seed (seed-workspace.ts) and a few legacy seeds create
 * `objects` rows that POINT at RustFS storage_keys but never actually
 * upload bytes to RustFS *and* never set `metadata.inlineBody` as the
 * dev fallback. Result: every preview/download/open of those files
 * 404s, which is ugly UX and confusing during testing.
 *
 * This backfill walks every file-kind object that lacks inline content,
 * generates a realistic placeholder matching its mime type (DOCX for
 * .helix.document, XLSX for .helix.sheet, a minimal PDF for PDFs, a
 * 1×1 PNG, etc.), writes it into `metadata.inlineBody` (base64), and
 * bumps mime_type + byte_size + sha256 to match.
 *
 * After running this, every `/api/drive/objects/:id/content` and
 * `/preview` request resolves to actual bytes instead of 404 —
 * "all wiring works."
 *
 * Idempotent on `metadata.inlineBody`: skips anything already populated. */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type postgres from "postgres";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import { createSqlClient } from "./client.js";

const requireCjs = createRequire(import.meta.url);
const ExcelJS = requireCjs("exceljs") as {
  Workbook: new () => {
    addWorksheet(name: string): { getCell(r: number, c: number): { value: unknown } };
    xlsx: { writeBuffer(): Promise<Buffer> };
  };
};
const PptxGen = requireCjs("pptxgenjs") as new () => {
  title: string;
  addSlide(): { addText(text: string, opts: Record<string, unknown>): void };
  write(opts: { outputType: "nodebuffer" }): Promise<Buffer>;
};

interface ObjectRow {
  readonly id: string;
  readonly mime_type: string;
  readonly metadata: Record<string, unknown>;
}

const OOXML_DOC = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const OOXML_SHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const OOXML_SLIDES = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

interface Backfilled {
  readonly bytes: Buffer;
  readonly newMime: string;
  readonly newExtension: string;
}

async function generatePlaceholder(row: ObjectRow): Promise<Backfilled | null> {
  const mime = row.mime_type;
  const title = stringMeta(row.metadata, "title") ?? stringMeta(row.metadata, "name") ?? "Untitled";
  const namedTitle = title.replace(/\.[a-z0-9]{1,6}$/i, ""); // strip extension if any

  // Word-document-shaped: legacy .helix.document, legacy MS Word, or just DOCX.
  if (
    mime === "application/vnd.helix.document" ||
    mime === "application/msword" ||
    mime === "application/rtf" ||
    mime.startsWith("text/markdown") ||
    mime.startsWith("text/plain") ||
    mime === OOXML_DOC
  ) {
    const bytes = await renderDocx(namedTitle, stringMeta(row.metadata, "plainText") ?? `Placeholder content for ${namedTitle}.`);
    return { bytes, newMime: OOXML_DOC, newExtension: "docx" };
  }

  // Spreadsheet-shaped: legacy .helix.sheet, legacy XLS, CSV — convert to XLSX
  // so the OnlyOffice editor can open it natively.
  if (
    mime === "application/vnd.helix.sheet" ||
    mime === "application/vnd.ms-excel" ||
    mime.startsWith("text/csv") ||
    mime === OOXML_SHEET
  ) {
    const bytes = await renderXlsx(namedTitle);
    return { bytes, newMime: OOXML_SHEET, newExtension: "xlsx" };
  }

  // Presentation-shaped: legacy .helix.slides, legacy PPT — convert to PPTX.
  if (
    mime === "application/vnd.helix.slides" ||
    mime === "application/vnd.ms-powerpoint" ||
    mime === OOXML_SLIDES
  ) {
    const bytes = await renderPptx(namedTitle);
    return { bytes, newMime: OOXML_SLIDES, newExtension: "pptx" };
  }

  // PDF — embed a tiny one-page valid PDF blob.
  if (mime === "application/pdf") {
    return { bytes: makeMinimalPdf(namedTitle), newMime: "application/pdf", newExtension: "pdf" };
  }

  // Raster image — embed a 1×1 transparent PNG. JPG/GIF reuse the same
  // blob and rewrite the mime; browsers happily render a PNG served as
  // image/jpeg (and the entry chip already shows the original format).
  if (mime.startsWith("image/")) {
    return { bytes: ONE_BY_ONE_PNG, newMime: mime, newExtension: "png" };
  }

  // Video / audio — skip. Generating valid video bytes is out of scope;
  // the UI's "preview not available" placeholder is the right outcome.
  if (mime.startsWith("video/") || mime.startsWith("audio/")) {
    return null;
  }

  // Anything else — fall back to a small text blob so the file at least
  // opens with SOMETHING when downloaded.
  const text = `Placeholder content for "${namedTitle}".\n\nThis file was created by a seed without binary content; the\nbackfill script populated this stub so the preview endpoint resolves.\n`;
  return { bytes: Buffer.from(text, "utf8"), newMime: "text/plain; charset=utf-8", newExtension: "txt" };
}

async function renderDocx(title: string, body: string): Promise<Buffer> {
  const paragraphs: Paragraph[] = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: title, bold: true })] }),
    new Paragraph({}),
    ...body.split(/\r?\n/).map((line) => new Paragraph({ children: [new TextRun(line)] })),
  ];
  return Packer.toBuffer(new Document({ sections: [{ children: paragraphs }] }));
}

async function renderXlsx(title: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.getCell(1, 1).value = title;
  ws.getCell(2, 1).value = "Placeholder content";
  return wb.xlsx.writeBuffer();
}

async function renderPptx(title: string): Promise<Buffer> {
  const pres = new PptxGen();
  pres.title = title;
  const slide = pres.addSlide();
  slide.addText(title, { x: 0.5, y: 1.5, w: 9, h: 1.5, fontSize: 36, bold: true });
  slide.addText("Placeholder slide content", { x: 0.5, y: 5.5, w: 9, fontSize: 14, color: "888888" });
  return pres.write({ outputType: "nodebuffer" });
}

/** A minimal but valid PDF (no images, just a title centred on one page).
 *  Hand-built bytes — avoids pulling in a heavyweight PDF library for what
 *  is fundamentally a fallback. */
function makeMinimalPdf(title: string): Buffer {
  const escaped = title.replace(/\\/g, "\\\\").replace(/[()]/g, (m) => `\\${m}`);
  const content = `BT /F1 24 Tf 50 700 Td (${escaped}) Tj ET`;
  const contentLength = Buffer.byteLength(content, "utf8");
  const objects = [
    "<</Type /Catalog /Pages 2 0 R>>",
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    "<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>>",
    `<</Length ${String(contentLength)}>>\nstream\n${content}\nendstream`,
    "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += `${String(i + 1)} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(body, "utf8");
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    body += `${off.toString().padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<</Size ${String(objects.length + 1)} /Root 1 0 R>>\nstartxref\n${String(xrefStart)}\n%%EOF`;
  return Buffer.from(body, "utf8");
}

/** 1×1 transparent PNG (Smallest valid PNG; ~70 bytes). */
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function stringMeta(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

async function main(): Promise<void> {
  const sql = createSqlClient();
  try {
    const rows = (await sql`
      select id, mime_type, metadata
      from objects
      where kind = 'file'
        and deleted_at is null
        and metadata->>'inlineBody' is null
    `) as unknown as readonly ObjectRow[];

    const stats = { backfilled: 0, skipped: 0, failed: 0 };
    for (const row of rows) {
      try {
        const result = await generatePlaceholder(row);
        if (result === null) {
          stats.skipped += 1;
          process.stdout.write(`  · ${row.id.slice(0, 8)}… mime=${row.mime_type} (skipped: no generator)\n`);
          continue;
        }
        const sha = createHash("sha256").update(result.bytes).digest("hex");
        const existingName =
          typeof row.metadata.name === "string" ? row.metadata.name : `${row.id}.${result.newExtension}`;
        // Strip ALL trailing extensions (handles cases like
        // "foo.helixdoc.docx" coming from a prior partial run) before
        // appending the new one. Loop until the name stops changing.
        let stem = existingName;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const stripped = stem.replace(/\.(helixdoc|helixsheet|helixdeck|docx|xlsx|pptx|pdf|txt|md|csv|png|jpg|jpeg|gif|svg|mp4|html|json|zip|rtf|odt)$/i, "");
          if (stripped === stem) break;
          stem = stripped;
        }
        const renamedName = `${stem.trim()}.${result.newExtension}`;
        await sql`
          update objects
          set mime_type = ${result.newMime},
              byte_size = ${result.bytes.byteLength},
              sha256 = ${sha},
              metadata = metadata || ${sql.json({
                name: renamedName,
                originalFormat: result.newExtension.toUpperCase(),
                inlineMime: result.newMime,
                inlineBody: result.bytes.toString("base64"),
                backfilled: true,
                backfilledAt: new Date().toISOString(),
              })},
              updated_at = now()
          where id = ${row.id}
        `;
        stats.backfilled += 1;
        process.stdout.write(`  ✓ ${row.id.slice(0, 8)}… → ${result.newExtension.toUpperCase()} (${String(result.bytes.byteLength)} bytes)\n`);
      } catch (error) {
        stats.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`  ✗ ${row.id.slice(0, 8)}…: ${message}\n`);
      }
    }
    process.stdout.write(
      "\n" + JSON.stringify({ ok: true, stats, total: rows.length }, null, 2) + "\n",
    );
    if (stats.failed > 0) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`backfill-empty-objects FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export { main as backfillEmptyObjects };
