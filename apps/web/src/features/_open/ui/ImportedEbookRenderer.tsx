/* EPUB reader — parses the .epub (a ZIP) and renders chapters in a sandboxed
 * iframe with Prev/Next + TOC navigation.
 *
 * We deliberately avoid epubjs's renderTo() because it expands the rendition
 * container to fit the whole spine (~67k px wide for a typical novel) when
 * the parent doesn't have a hard pixel width. Parsing the EPUB ourselves
 * gives full control over layout: one chapter at a time inside a srcdoc
 * iframe, with chrome that matches the rest of the universal-open viewers.
 *
 * EPUB structure: a ZIP whose META-INF/container.xml points at a "rootfile"
 * (typically OEBPS/content.opf). The OPF lists the spine (reading order) and
 * the manifest (file paths). The TOC lives in nav.xhtml (EPUB 3) or
 * toc.ncx (EPUB 2). We resolve the spine + nav once on mount and let the
 * user click through chapters.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ImportedEbook } from "../parsers/types.js";

interface SpineEntry {
  readonly id: string;
  readonly href: string;
}

interface TocEntry {
  readonly href: string;
  readonly label: string;
}

interface ParsedEpub {
  readonly title: string | null;
  readonly author: string | null;
  readonly opfDir: string;
  readonly spine: readonly SpineEntry[];
  readonly manifest: Record<string, string>;
  readonly toc: readonly TocEntry[];
  readonly chapterHtml: (href: string) => Promise<string>;
}

export interface ImportedEbookRendererProps {
  readonly ebook: ImportedEbook;
  readonly objectId: string;
  readonly fileName?: string;
}

export function ImportedEbookRenderer({ ebook, objectId, fileName }: ImportedEbookRendererProps) {
  const [parsed, setParsed] = useState<ParsedEpub | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spineIndex, setSpineIndex] = useState(0);
  const [chapterDoc, setChapterDoc] = useState<string>("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await parseEpub(ebook.bytes);
        if (cancelled) return;
        setParsed(result);
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ebook.bytes]);

  useEffect(() => {
    if (parsed === null) return;
    const entry = parsed.spine[spineIndex];
    if (entry === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const html = await parsed.chapterHtml(entry.href);
        if (cancelled) return;
        setChapterDoc(html);
        containerRef.current?.scrollTo({ top: 0 });
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [parsed, spineIndex]);

  const currentChapterLabel = useMemo(() => {
    if (parsed === null) return null;
    const entry = parsed.spine[spineIndex];
    if (entry === undefined) return null;
    const tocMatch = parsed.toc.find(
      (t) => t.href === entry.href || t.href.endsWith(entry.href) || entry.href.endsWith(t.href),
    );
    return tocMatch?.label ?? entry.href.split("/").pop() ?? null;
  }, [parsed, spineIndex]);

  const navPrev = (): void => {
    setSpineIndex((idx) => Math.max(0, idx - 1));
  };
  const navNext = (): void => {
    setSpineIndex((idx) => Math.min((parsed?.spine.length ?? 1) - 1, idx + 1));
  };
  const navTo = (href: string): void => {
    if (parsed === null) return;
    const idx = parsed.spine.findIndex((s) => s.href === href || s.href.endsWith(href));
    if (idx >= 0) setSpineIndex(idx);
  };

  const title = parsed?.title ?? fileName ?? "EPUB";
  const subtitle =
    parsed?.author !== null && parsed?.author !== undefined ? ` · ${parsed.author}` : "";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        width: "100%",
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "8px 16px",
          background: "var(--surface-2)",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          minWidth: 0,
        }}
      >
        <strong>{title}</strong>
        <span style={{ color: "var(--text-3)", fontSize: "var(--text-caption)" }}>
          {ebook.format.label}
          {subtitle}
          {` · ${formatBytes(ebook.bytes.byteLength)}`}
          {parsed !== null ? ` · Chapter ${spineIndex + 1} of ${parsed.spine.length}` : null}
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn sm"
          onClick={navPrev}
          disabled={parsed === null || spineIndex === 0}
          aria-label="Previous chapter"
        >
          ← Prev
        </button>
        {parsed !== null && parsed.toc.length > 0 ? (
          <select
            aria-label="Jump to chapter"
            className="btn sm"
            value=""
            onChange={(e) => {
              if (e.target.value !== "") {
                navTo(e.target.value);
                e.target.value = "";
              }
            }}
          >
            <option value="">{currentChapterLabel ?? "Contents"}</option>
            {parsed.toc.map((entry) => (
              <option key={entry.href} value={entry.href}>
                {entry.label}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className="btn sm"
          onClick={navNext}
          disabled={parsed === null || spineIndex >= parsed.spine.length - 1}
          aria-label="Next chapter"
        >
          Next →
        </button>
        <a
          href={`/api/drive/objects/${objectId}/content?download=1`}
          className="btn sm"
          download={fileName ?? ""}
        >
          Download
        </a>
      </div>
      {error !== null ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--danger)",
            padding: 32,
          }}
        >
          Could not open EPUB: {error}
        </div>
      ) : parsed === null ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-2)",
          }}
        >
          Loading book…
        </div>
      ) : (
        <div
          ref={containerRef}
          style={{
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            background: "#fafafa",
            overflow: "auto",
            padding: 0,
          }}
          aria-label="EPUB content"
        >
          <iframe
            srcDoc={wrapChapterHtml(chapterDoc)}
            title={currentChapterLabel ?? "Chapter"}
            sandbox="allow-same-origin"
            style={{
              width: "100%",
              minHeight: "100%",
              border: "none",
              background: "white",
            }}
          />
        </div>
      )}
    </div>
  );
}

function wrapChapterHtml(inner: string): string {
  // Strip xml declarations / DOCTYPE so the iframe srcdoc parses as HTML5
  // regardless of source quirks. Inject a sensible reader stylesheet.
  const stripped = inner.replace(/<\?xml[^>]*\?>/gi, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    body { font-family: Georgia, 'Times New Roman', serif; line-height: 1.7; color: #222; padding: 48px 64px; max-width: 760px; margin: 0 auto; background: white; }
    h1, h2, h3 { font-family: 'Helvetica Neue', Arial, sans-serif; line-height: 1.25; }
    h1 { font-size: 28px; margin-top: 0; }
    h2 { font-size: 22px; margin-top: 2em; }
    h3 { font-size: 18px; }
    p { margin: 0 0 1em 0; }
    a { color: #3b82f6; }
    img, svg { max-width: 100%; height: auto; }
    blockquote { border-left: 3px solid #d1d5db; padding-left: 16px; color: #4b5563; margin: 1.2em 0; }
    pre, code { font-family: 'SF Mono', Menlo, monospace; }
    pre { background: #f4f4f5; padding: 12px; border-radius: 6px; overflow-x: auto; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 2em 0; }
  </style></head><body>${stripped}</body></html>`;
}

async function parseEpub(bytes: ArrayBuffer): Promise<ParsedEpub> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);

  const containerXml = await zip.file("META-INF/container.xml")?.async("text");
  if (containerXml === undefined) throw new Error("Missing META-INF/container.xml");
  const opfPath = matchAttribute(containerXml, "rootfile", "full-path");
  if (opfPath === null) throw new Error("Missing rootfile in container.xml");

  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const opfXml = await zip.file(opfPath)?.async("text");
  if (opfXml === undefined) throw new Error(`Missing OPF at ${opfPath}`);

  const title = matchTagText(opfXml, "dc:title") ?? matchTagText(opfXml, "title");
  const author = matchTagText(opfXml, "dc:creator") ?? matchTagText(opfXml, "creator");

  // Manifest: id -> href
  const manifest: Record<string, string> = {};
  for (const itemMatch of matchAllAttributes(opfXml, "item")) {
    const id = itemMatch["id"];
    const href = itemMatch["href"];
    if (id !== undefined && href !== undefined) manifest[id] = href;
  }

  // Spine: ordered idrefs
  const spine: SpineEntry[] = [];
  for (const itemRef of matchAllAttributes(opfXml, "itemref")) {
    const idref = itemRef["idref"];
    if (idref === undefined) continue;
    const href = manifest[idref];
    if (href === undefined) continue;
    spine.push({ id: idref, href });
  }

  // TOC: try nav.xhtml first (EPUB 3), then toc.ncx (EPUB 2).
  let toc: TocEntry[] = [];
  const navRef = Object.entries(manifest).find(
    ([, href]) => href.endsWith("nav.xhtml") || href.endsWith("nav.html"),
  );
  if (navRef !== undefined) {
    const navXml = await zip.file(opfDir + navRef[1])?.async("text");
    if (navXml !== undefined) toc = parseNavToc(navXml);
  }
  if (toc.length === 0) {
    const ncxRef = Object.entries(manifest).find(([, href]) => href.endsWith(".ncx"));
    if (ncxRef !== undefined) {
      const ncxXml = await zip.file(opfDir + ncxRef[1])?.async("text");
      if (ncxXml !== undefined) toc = parseNcxToc(ncxXml);
    }
  }

  return {
    title,
    author,
    opfDir,
    spine,
    manifest,
    toc,
    chapterHtml: async (href) => {
      const fullPath = opfDir + href.split("#")[0]!;
      const data = await zip.file(fullPath)?.async("text");
      if (data === undefined) throw new Error(`Chapter file missing: ${fullPath}`);
      return extractBody(data);
    },
  };
}

function extractBody(html: string): string {
  const lower = html.toLowerCase();
  const bodyStart = lower.indexOf("<body");
  if (bodyStart === -1) return html;
  const bodyEnd = lower.lastIndexOf("</body>");
  if (bodyEnd === -1) return html;
  const afterOpen = html.indexOf(">", bodyStart);
  if (afterOpen === -1) return html;
  return html.slice(afterOpen + 1, bodyEnd);
}

function matchAttribute(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["']`, "i");
  const m = xml.match(re);
  return m === null ? null : m[1]!;
}

function matchAllAttributes(xml: string, tag: string): ReadonlyArray<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>`, "gi");
  for (const match of xml.matchAll(re)) {
    const attrs: Record<string, string> = {};
    const attrRe = /(\w[\w-]*)=["']([^"']*)["']/g;
    for (const am of (match[1] ?? "").matchAll(attrRe)) {
      attrs[am[1]!] = am[2]!;
    }
    out.push(attrs);
  }
  return out;
}

function matchTagText(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i");
  const m = xml.match(re);
  if (m === null) return null;
  return m[1]!.trim() || null;
}

function parseNavToc(navXml: string): TocEntry[] {
  const navMatch = /<nav[^>]*epub:type=["']toc["'][^>]*>([\s\S]*?)<\/nav>/i;
  const navSection = navXml.match(navMatch);
  const region = navSection !== null ? navSection[1]! : navXml;
  const out: TocEntry[] = [];
  const linkRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of region.matchAll(linkRe)) {
    const label = m[2]!
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (label.length > 0) out.push({ href: m[1]!, label });
  }
  return out;
}

function parseNcxToc(ncxXml: string): TocEntry[] {
  const out: TocEntry[] = [];
  const re = /<navPoint\b[^>]*>([\s\S]*?)<\/navPoint>/gi;
  for (const m of ncxXml.matchAll(re)) {
    const block = m[1]!;
    const labelMatch = block.match(/<text>([^<]+)<\/text>/i);
    const srcMatch = block.match(/<content[^>]*src=["']([^"']+)["']/i);
    const label = labelMatch !== null ? labelMatch[1]?.trim() : null;
    const src = srcMatch !== null ? srcMatch[1] : null;
    if (label !== null && label !== undefined && src !== null && src !== undefined) {
      out.push({ href: src, label });
    }
  }
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
