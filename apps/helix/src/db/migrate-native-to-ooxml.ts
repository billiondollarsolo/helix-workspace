/* migrate-native-to-ooxml.ts
 *
 * Phase 4 of the OnlyOffice migration: convert every native Helix doc /
 * sheet / slide deck row into the equivalent OOXML file stored on the
 * shared `objects` row.
 *
 * Strategy: in-place migration. The shared-PK convention means each
 * `docs_documents.id` already has a matching `objects.id` row — we
 * rewrite the objects row to carry the OOXML bytes + mime type. The
 * native source rows (`docs_documents`, `sheets`, `slide_decks`) are
 * left in place; Phase 6 freezes / drops them.
 *
 * Idempotent: each migrated objects row gets
 * `metadata.migratedFromNative = true`. Re-running skips them. To force
 * re-migration of a row, clear that flag manually.
 *
 * Source content:
 *   • Docs   → `metadata.plainText` (always populated by our seeds); when
 *              absent, falls back to the doc title only.
 *   • Sheets → `sheet_tabs` + `sheet_cells` (one Excel sheet per tab).
 *   • Slides → `slides.content` (one PPTX slide per row).
 *
 * Output: real OOXML binaries written into `objects.metadata.inlineBody`
 * (base64) — the same dev affordance the corpus seed uses, so the
 * existing /api/drive/objects/:id/content endpoint serves them unchanged.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type postgres from "postgres";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { createSqlClient } from "./client.js";

const requireCjs = createRequire(import.meta.url);
const PptxGen = requireCjs("pptxgenjs") as new () => {
  title: string;
  addSlide(): {
    addText(text: string, opts: Record<string, unknown>): void;
  };
  write(opts: { outputType: "nodebuffer" }): Promise<Buffer>;
};
const ExcelJS = requireCjs("exceljs") as {
  Workbook: new () => {
    addWorksheet(name: string): {
      getCell(row: number, col: number): { value: unknown };
    };
    xlsx: {
      writeBuffer(): Promise<Buffer>;
    };
  };
};

interface Stats {
  docs: { converted: number; skipped: number; failed: number };
  sheets: { converted: number; skipped: number; failed: number };
  decks: { converted: number; skipped: number; failed: number };
}

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

async function migrate(sql: postgres.Sql): Promise<Stats> {
  const stats: Stats = {
    docs: { converted: 0, skipped: 0, failed: 0 },
    sheets: { converted: 0, skipped: 0, failed: 0 },
    decks: { converted: 0, skipped: 0, failed: 0 },
  };

  // -------- docs --------
  const docs = (await sql`
    select d.id, d.title,
           d.metadata->>'plainText' as plain_text,
           o.metadata as obj_metadata
    from docs_documents d
    join objects o on o.id = d.id
    where d.deleted_at is null
      and (o.metadata->>'migratedFromNative') is null
  `) as unknown as readonly {
    readonly id: string;
    readonly title: string;
    readonly plain_text: string | null;
    readonly obj_metadata: Record<string, unknown>;
  }[];

  for (const doc of docs) {
    try {
      const body = await renderDocx(doc.title, doc.plain_text ?? doc.title);
      await rewriteObject(sql, doc.id, doc.obj_metadata, body, DOCX_MIME, "docx", doc.title);
      stats.docs.converted += 1;
      process.stdout.write(`  ✓ doc   ${doc.id.slice(0, 8)}… ${doc.title}\n`);
    } catch (error) {
      stats.docs.failed += 1;
      process.stderr.write(`  ✗ doc   ${doc.id.slice(0, 8)}… ${doc.title} → ${errorMessage(error)}\n`);
    }
  }

  // -------- sheets --------
  const sheets = (await sql`
    select s.id, s.title, o.metadata as obj_metadata
    from sheets s
    join objects o on o.id = s.id
    where s.deleted_at is null
      and (o.metadata->>'migratedFromNative') is null
  `) as unknown as readonly {
    readonly id: string;
    readonly title: string;
    readonly obj_metadata: Record<string, unknown>;
  }[];

  for (const sheet of sheets) {
    try {
      const tabs = (await sql`
        select id, name from sheet_tabs
        where sheet_id = ${sheet.id} and deleted_at is null
        order by position asc
      `) as unknown as readonly { readonly id: string; readonly name: string }[];
      const tabsWithCells = await Promise.all(
        tabs.map(async (tab) => ({
          name: tab.name,
          cells: (await sql`
            select row, col, value from sheet_cells
            where sheet_tab_id = ${tab.id}
            order by row asc, col asc
          `) as unknown as readonly {
            readonly row: number;
            readonly col: number;
            readonly value: string;
          }[],
        })),
      );
      const body = await renderXlsx(sheet.title, tabsWithCells);
      await rewriteObject(sql, sheet.id, sheet.obj_metadata, body, XLSX_MIME, "xlsx", sheet.title);
      stats.sheets.converted += 1;
      process.stdout.write(`  ✓ sheet ${sheet.id.slice(0, 8)}… ${sheet.title} (${String(tabs.length)} tabs)\n`);
    } catch (error) {
      stats.sheets.failed += 1;
      process.stderr.write(`  ✗ sheet ${sheet.id.slice(0, 8)}… ${sheet.title} → ${errorMessage(error)}\n`);
    }
  }

  // -------- decks --------
  const decks = (await sql`
    select d.id, d.title, o.metadata as obj_metadata
    from slide_decks d
    join objects o on o.id = d.id
    where d.deleted_at is null
      and (o.metadata->>'migratedFromNative') is null
  `) as unknown as readonly {
    readonly id: string;
    readonly title: string;
    readonly obj_metadata: Record<string, unknown>;
  }[];

  for (const deck of decks) {
    try {
      const slides = (await sql`
        select position, layout, content, speaker_notes
        from slides where deck_id = ${deck.id}
        order by position asc
      `) as unknown as readonly {
        readonly position: number;
        readonly layout: string;
        readonly content: Record<string, unknown>;
        readonly speaker_notes: string;
      }[];
      const body = await renderPptx(deck.title, slides);
      await rewriteObject(sql, deck.id, deck.obj_metadata, body, PPTX_MIME, "pptx", deck.title);
      stats.decks.converted += 1;
      process.stdout.write(`  ✓ deck  ${deck.id.slice(0, 8)}… ${deck.title} (${String(slides.length)} slides)\n`);
    } catch (error) {
      stats.decks.failed += 1;
      process.stderr.write(`  ✗ deck  ${deck.id.slice(0, 8)}… ${deck.title} → ${errorMessage(error)}\n`);
    }
  }

  return stats;
}

/** Update the existing objects row to carry the new OOXML bytes. We
 *  preserve owner/storage_key/folder bindings and just swap the mime and
 *  the inline body. */
async function rewriteObject(
  sql: postgres.Sql,
  objectId: string,
  existingMetadata: Record<string, unknown>,
  body: Buffer,
  mime: string,
  extension: "docx" | "xlsx" | "pptx",
  title: string,
): Promise<void> {
  const sha = createHash("sha256").update(body).digest("hex");
  const sanitizedTitle = title.replace(/[\\/:*?"<>|]+/g, "-").trim();
  const newName = sanitizedTitle.toLowerCase().endsWith(`.${extension}`)
    ? sanitizedTitle
    : `${sanitizedTitle}.${extension}`;
  // Drop the old `app: "docs"|"sheets"|"slides"` discriminator — these
  // are now raw drive files (Drive UI opens them via OnlyOffice, not the
  // legacy native editor surface).
  const updatedMetadata = {
    ...existingMetadata,
    name: newName,
    title,
    app: null,
    originalFormat: extension.toUpperCase(),
    migratedFromNative: true,
    migratedAt: new Date().toISOString(),
    inlineMime: mime,
    inlineBody: body.toString("base64"),
  };
  await sql`
    update objects
    set mime_type = ${mime},
        byte_size = ${body.byteLength},
        sha256 = ${sha},
        metadata = ${sql.json(updatedMetadata)},
        updated_at = now()
    where id = ${objectId}
  `;
}

// -----------------------------------------------------------------
// Renderers — reuse the same libs the corpus generator uses.
// -----------------------------------------------------------------

async function renderDocx(title: string, markdownOrText: string): Promise<Buffer> {
  const lines = markdownOrText.split(/\r?\n/);
  const paragraphs: Paragraph[] = [
    new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 36 })] }),
    new Paragraph({}),
  ];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) {
      paragraphs.push(new Paragraph({}));
      continue;
    }
    if (line.startsWith("# ")) {
      paragraphs.push(
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(line.slice(2))] }),
      );
      continue;
    }
    if (line.startsWith("## ")) {
      paragraphs.push(
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(line.slice(3))] }),
      );
      continue;
    }
    if (line.startsWith("### ")) {
      paragraphs.push(
        new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(line.slice(4))] }),
      );
      continue;
    }
    paragraphs.push(new Paragraph({ children: [new TextRun(line)] }));
  }
  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBuffer(doc);
}

async function renderXlsx(
  title: string,
  tabs: readonly { readonly name: string; readonly cells: readonly { readonly row: number; readonly col: number; readonly value: string }[] }[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  if (tabs.length === 0) {
    const ws = wb.addWorksheet("Sheet1");
    ws.getCell(1, 1).value = title;
  } else {
    for (const tab of tabs) {
      const ws = wb.addWorksheet(tab.name.slice(0, 31) || "Sheet");
      for (const cell of tab.cells) {
        // exceljs uses 1-indexed (row, col); our DB stores 0-indexed.
        ws.getCell(cell.row + 1, cell.col + 1).value = cell.value;
      }
    }
  }
  return wb.xlsx.writeBuffer();
}

async function renderPptx(
  deckTitle: string,
  slides: readonly {
    readonly position: number;
    readonly layout: string;
    readonly content: Record<string, unknown>;
    readonly speaker_notes: string;
  }[],
): Promise<Buffer> {
  const pres = new PptxGen();
  pres.title = deckTitle;

  // Title slide
  const titleSlide = pres.addSlide();
  titleSlide.addText(deckTitle, {
    x: 0.5,
    y: 1.5,
    w: 9,
    h: 1.5,
    fontSize: 36,
    bold: true,
  });

  for (const slide of slides) {
    const s = pres.addSlide();
    const content = slide.content;
    const slideTitle = typeof content.title === "string" ? content.title : `Slide ${String(slide.position + 1)}`;
    const subtitle = typeof content.subtitle === "string" ? content.subtitle : "";
    const body = typeof content.body === "string" ? content.body : extractBodyFromBlocks(content);

    s.addText(slideTitle, { x: 0.5, y: 0.4, w: 9, h: 0.7, fontSize: 24, bold: true });
    if (subtitle.length > 0) {
      s.addText(subtitle, { x: 0.5, y: 1.1, w: 9, h: 0.5, fontSize: 16, color: "555555" });
    }
    if (body.length > 0) {
      s.addText(body.slice(0, 1500), {
        x: 0.5,
        y: 1.8,
        w: 9,
        h: 4.5,
        fontSize: 14,
        valign: "top",
      });
    }
  }

  return pres.write({ outputType: "nodebuffer" });
}

/** When `slides.content` carries a block-based layout (the editor's
 *  Tiptap-ish structure), pull text out of any string-valued fields so
 *  the migrated PPTX has SOMETHING beyond just the title. Pragmatic, not
 *  faithful — Phase 4 prioritizes "lossless on round-trip after this
 *  point" over "perfect rendering of legacy content". */
function extractBodyFromBlocks(content: Record<string, unknown>): string {
  const pieces: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      pieces.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === "object") {
      for (const inner of Object.values(value)) visit(inner);
    }
  };
  for (const key of ["blocks", "body", "items", "lines", "text", "eyebrow"]) {
    visit(content[key]);
  }
  return pieces.join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const sql = createSqlClient();
  try {
    const stats = await migrate(sql);
    process.stdout.write(
      "\n" +
        JSON.stringify({ ok: true, stats }, null, 2) +
        "\n",
    );
    if (stats.docs.failed + stats.sheets.failed + stats.decks.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`migrate-native-to-ooxml FAILED: ${errorMessage(error)}\n`);
    process.exit(1);
  });
}

export { migrate };
