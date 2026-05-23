/* generate-corpus.ts
 *
 * Produces native office files (DOCX, PPTX, XLSX, TXT) from the already-
 * cached corpus content under seed/corpus-cache/<manifestId>/. The output
 * is written to a sibling cache directory keyed by a synthetic
 * manifest_id (e.g. `docx.wikipedia.postgresql`) so seed-corpus.ts can
 * import it the same way it imports fetched binaries.
 *
 * Run after `db:fetch:corpus`. Idempotent on content hash like the
 * fetcher: skip if the generated body matches the cached metadata.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { createRequire } from "node:module";
// pptxgenjs ships as CommonJS only; default-import under ESM/tsx wraps the
// constructor in unpredictable ways. Drop down to CJS via createRequire so
// `new PptxGen()` works regardless of loader.
const requireCjs = createRequire(import.meta.url);
const PptxGen = requireCjs("pptxgenjs") as new () => {
  title: string;
  addSlide(): {
    addText(text: string, opts: Record<string, unknown>): void;
  };
  write(opts: { outputType: "nodebuffer" }): Promise<Buffer>;
};

const CACHE_ROOT = resolve(import.meta.dirname, "..", "..", "seed", "corpus-cache");

interface SourceItem {
  readonly sourceManifestId: string;
  readonly title: string;
  readonly genKind: "docx" | "pptx" | "txt";
  readonly outputManifestId: string;
}

/** Generator manifest — declares which generated artifacts to produce and
 *  which source cached doc they derive from. seed-corpus's manifest.json
 *  references the `outputManifestId` to load the generated file. */
const GENERATORS: readonly SourceItem[] = [
  { sourceManifestId: "doc.wikipedia.postgresql",   title: "PostgreSQL — overview",        genKind: "docx", outputManifestId: "docx.wikipedia.postgresql" },
  { sourceManifestId: "doc.wikipedia.kubernetes",   title: "Kubernetes — overview",        genKind: "docx", outputManifestId: "docx.wikipedia.kubernetes" },
  { sourceManifestId: "doc.wikipedia.typescript",   title: "TypeScript — overview",        genKind: "docx", outputManifestId: "docx.wikipedia.typescript" },
  { sourceManifestId: "doc.wikipedia.cloud-computing", title: "Cloud Computing — overview", genKind: "docx", outputManifestId: "docx.wikipedia.cloud-computing" },

  { sourceManifestId: "doc.wikipedia.apple-inc",    title: "Apple Inc. — investor deck",   genKind: "pptx", outputManifestId: "pptx.wikipedia.apple-inc" },
  { sourceManifestId: "doc.wikipedia.tesla-inc",    title: "Tesla, Inc. — investor deck",  genKind: "pptx", outputManifestId: "pptx.wikipedia.tesla-inc" },
  { sourceManifestId: "doc.wikipedia.microsoft",    title: "Microsoft — investor deck",    genKind: "pptx", outputManifestId: "pptx.wikipedia.microsoft" },
  { sourceManifestId: "doc.wikipedia.nvidia",       title: "Nvidia — investor deck",       genKind: "pptx", outputManifestId: "pptx.wikipedia.nvidia" },

  { sourceManifestId: "doc.wikipedia.federal-reserve",      title: "Federal Reserve — plain text",      genKind: "txt", outputManifestId: "txt.wikipedia.federal-reserve" },
  { sourceManifestId: "doc.wikipedia.transformer-architecture", title: "Transformer architecture — plain text", genKind: "txt", outputManifestId: "txt.wikipedia.transformer" },
  { sourceManifestId: "doc.wikipedia.large-language-model", title: "Large language models — plain text", genKind: "txt", outputManifestId: "txt.wikipedia.llm" },
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Markdown → DOCX. Heading lines become Heading paragraphs; everything
 *  else becomes a body paragraph. Good enough for hydrated corpus content. */
function markdownToDocx(title: string, markdown: string): Buffer | Promise<Buffer> {
  const lines = markdown.split(/\r?\n/);
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
      paragraphs.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(line.slice(2))] }));
      continue;
    }
    if (line.startsWith("## ")) {
      paragraphs.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(line.slice(3))] }));
      continue;
    }
    if (line.startsWith("### ")) {
      paragraphs.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(line.slice(4))] }));
      continue;
    }
    paragraphs.push(new Paragraph({ children: [new TextRun(line)] }));
  }
  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBuffer(doc);
}

/** Markdown → PPTX. Splits the body on `## ` headings (or paragraph
 *  boundaries when there are none) to produce one slide per chunk. */
async function markdownToPptx(title: string, markdown: string): Promise<Buffer> {
  const pres = new PptxGen();
  pres.title = title;

  const chunks = chunkForSlides(markdown);

  // Title slide
  const titleSlide = pres.addSlide();
  titleSlide.addText(title, { x: 0.5, y: 1.5, w: 9, h: 1.5, fontSize: 36, bold: true });
  titleSlide.addText("Source: Wikipedia · CC BY-SA 4.0", { x: 0.5, y: 5.5, w: 9, fontSize: 12, color: "888888" });

  for (const chunk of chunks) {
    const slide = pres.addSlide();
    slide.addText(chunk.heading, { x: 0.5, y: 0.4, w: 9, h: 0.7, fontSize: 24, bold: true });
    slide.addText(chunk.body, { x: 0.5, y: 1.3, w: 9, h: 5, fontSize: 14, valign: "top" });
  }

  return pres.write({ outputType: "nodebuffer" }) as Promise<Buffer>;
}

interface SlideChunk {
  readonly heading: string;
  readonly body: string;
}
function chunkForSlides(markdown: string): readonly SlideChunk[] {
  const lines = markdown.split(/\r?\n/);
  const chunks: SlideChunk[] = [];
  let heading = "Overview";
  let body: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (body.length > 0 || heading !== "Overview") {
        chunks.push({ heading, body: body.join("\n").trim() });
      }
      heading = line.slice(3).trim();
      body = [];
      continue;
    }
    if (line.startsWith("# ")) {
      continue; // title — already covered by the title slide
    }
    body.push(line);
  }
  if (body.length > 0) {
    chunks.push({ heading, body: body.join("\n").trim() });
  }
  // Cap the body length per slide to keep them readable.
  return chunks.slice(0, 8).map((c) => ({ ...c, body: c.body.slice(0, 1200) }));
}

/** Markdown → plain TXT. Strips markup minimally. */
function markdownToTxt(title: string, markdown: string): Buffer {
  const stripped = markdown
    .replace(/^#+ /gm, "")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  return Buffer.from(`${title}\n${"=".repeat(title.length)}\n\n${stripped}\n`, "utf8");
}

async function ensureGenerated(spec: SourceItem): Promise<{ status: "generated" | "skipped"; hash: string }> {
  const srcDir = resolve(CACHE_ROOT, spec.sourceManifestId);
  const srcMetaPath = resolve(srcDir, "metadata.json");
  if (!(await exists(srcMetaPath))) {
    throw new Error(`generate-corpus: source ${spec.sourceManifestId} not cached — run pnpm helix db:fetch:corpus first.`);
  }
  const srcMeta = JSON.parse(await readFile(srcMetaPath, "utf8")) as { readonly extension: string; readonly sha256: string };
  const srcContent = await readFile(resolve(srcDir, `content.${srcMeta.extension}`));
  const markdown = srcContent.toString("utf8");

  const outDir = resolve(CACHE_ROOT, spec.outputManifestId);
  const outMetaPath = resolve(outDir, "metadata.json");
  const outContentPath = resolve(outDir, `content.${spec.genKind}`);

  let body: Buffer;
  if (spec.genKind === "docx") body = await markdownToDocx(spec.title, markdown);
  else if (spec.genKind === "pptx") body = await markdownToPptx(spec.title, markdown);
  else body = markdownToTxt(spec.title, markdown);
  const hash = sha256(body);

  if (await exists(outMetaPath)) {
    const cached = JSON.parse(await readFile(outMetaPath, "utf8")) as { readonly sha256: string };
    if (cached.sha256 === hash && (await exists(outContentPath))) {
      return { status: "skipped", hash };
    }
  }

  await mkdir(dirname(outContentPath), { recursive: true });
  await writeFile(outContentPath, body);
  await writeFile(
    outMetaPath,
    JSON.stringify(
      {
        manifestId: spec.outputManifestId,
        sourceManifestId: spec.sourceManifestId,
        generatedFrom: srcMeta.sha256,
        sha256: hash,
        extension: spec.genKind,
        contentType:
          spec.genKind === "docx"
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : spec.genKind === "pptx"
              ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
              : "text/plain; charset=utf-8",
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return { status: "generated", hash };
}

async function main(): Promise<void> {
  const stats = { generated: 0, skipped: 0, failed: 0 };
  for (const spec of GENERATORS) {
    try {
      const r = await ensureGenerated(spec);
      if (r.status === "skipped") {
        stats.skipped += 1;
        process.stdout.write(`  ${spec.outputManifestId.padEnd(40)} (cached, sha256 ${r.hash.slice(0, 12)}…)\n`);
      } else {
        stats.generated += 1;
        process.stdout.write(`✓ ${spec.outputManifestId.padEnd(40)} generated (sha256 ${r.hash.slice(0, 12)}…)\n`);
      }
    } catch (error) {
      stats.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`✗ ${spec.outputManifestId}: ${message}\n`);
    }
  }
  process.stdout.write(
    `\ngenerate-corpus: generated=${String(stats.generated)} skipped=${String(stats.skipped)} failed=${String(stats.failed)} (total ${String(GENERATORS.length)})\n`,
  );
  if (stats.failed > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
