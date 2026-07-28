/* Native PDF viewer — renders pages on demand via pdfjs-dist (already a dep).
 *
 * v1 is read-only: scroll through pages with the browser's native scroll, plus
 * zoom buttons + a page-N-of-N indicator. v2 will add per-page text-layer
 * extraction for selection + search, form-field interaction (using the
 * existing drive.pdfFormState.* tools), and annotation rendering.
 */

import { useEffect, useRef, useState } from "react";
import type { ImportedPdf } from "../parsers/types.js";

export interface ImportedPdfRendererProps {
  readonly pdf: ImportedPdf;
  readonly objectId: string;
  readonly fileName?: string;
}

interface PdfDocLite {
  numPages: number;
  getPage(n: number): Promise<PdfPageLite>;
}
interface PdfPageLite {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(ctx: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void> };
}

export function ImportedPdfRenderer({ pdf, objectId, fileName }: ImportedPdfRendererProps) {
  const [doc, setDoc] = useState<PdfDocLite | null>(null);
  const [scale, setScale] = useState(1.0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Import only the API surface; pdfjs ships its own worker, configured
        // via an inlined Vite import so no extra wiring is required.
        const pdfjs = await import("pdfjs-dist");
        // Worker setup: Vite resolves the `?url` query to a built worker URL.
        const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
        (pdfjs.GlobalWorkerOptions as { workerSrc: string }).workerSrc = workerUrl;
        const loadingTask = pdfjs.getDocument({ data: pdf.bytes });
        const loaded = await loadingTask.promise;
        if (cancelled) return;
        setDoc(loaded as unknown as PdfDocLite);
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? "Failed to load PDF");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf.bytes]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PdfToolbar
        objectId={objectId}
        fileName={fileName}
        pageCount={doc?.numPages}
        scale={scale}
        onScaleChange={setScale}
      />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          background: "var(--bg)",
          padding: "16px 0",
        }}
      >
        {error !== null ? (
          <div style={{ padding: 32, textAlign: "center", color: "var(--danger)" }}>
            Failed to render PDF: {error}
          </div>
        ) : doc === null ? (
          <div style={{ padding: 32, textAlign: "center", color: "var(--text-3)" }}>
            Loading PDF…
          </div>
        ) : (
          <PdfPages doc={doc} scale={scale} />
        )}
      </div>
    </div>
  );
}

function PdfPages({ doc, scale }: { readonly doc: PdfDocLite; readonly scale: number }) {
  const pages = Array.from({ length: doc.numPages }, (_, idx) => idx + 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
      {pages.map((pageNum) => (
        <PdfPage key={pageNum} doc={doc} pageNum={pageNum} scale={scale} />
      ))}
    </div>
  );
}

function PdfPage({
  doc,
  pageNum,
  scale,
}: {
  readonly doc: PdfDocLite;
  readonly pageNum: number;
  readonly scale: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const page = await doc.getPage(pageNum);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const renderTask = page.render({ canvasContext: ctx, viewport });
      try {
        await renderTask.promise;
      } catch {
        // Render cancellations (e.g. unmount mid-render) are non-fatal.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageNum, scale]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        background: "white",
        boxShadow: "var(--shadow-md)",
        maxWidth: "100%",
      }}
      aria-label={`PDF page ${pageNum}`}
    />
  );
}

function PdfToolbar({
  objectId,
  fileName,
  pageCount,
  scale,
  onScaleChange,
}: {
  readonly objectId: string;
  readonly fileName?: string;
  readonly pageCount: number | undefined;
  readonly scale: number;
  readonly onScaleChange: (s: number) => void;
}) {
  return (
    <div
      style={{
        padding: "8px 16px",
        background: "var(--surface-2)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <strong style={{ fontSize: "var(--text-body)" }}>{fileName ?? "PDF"}</strong>
      {pageCount !== undefined ? (
        <span style={{ color: "var(--text-3)", fontSize: "var(--text-caption)" }}>
          {pageCount} pages
        </span>
      ) : null}
      <div style={{ flex: 1 }} />
      <button
        type="button"
        className="btn sm"
        onClick={() => onScaleChange(Math.max(0.25, scale - 0.25))}
        disabled={scale <= 0.25}
      >
        −
      </button>
      <span
        style={{
          minWidth: 56,
          textAlign: "center",
          fontSize: "var(--text-caption)",
          color: "var(--text-2)",
        }}
      >
        {Math.round(scale * 100)}%
      </span>
      <button
        type="button"
        className="btn sm"
        onClick={() => onScaleChange(Math.min(4, scale + 0.25))}
        disabled={scale >= 4}
      >
        +
      </button>
      <a
        href={`/api/drive/objects/${objectId}/content?download=1`}
        className="btn sm"
        download={fileName ?? ""}
      >
        Download
      </a>
    </div>
  );
}
