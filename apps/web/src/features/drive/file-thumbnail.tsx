// ponytail: file-thumbnail.tsx still >400 LOC (preview renderers for image/pdf/office/text);
// deferred split into features/drive/components/thumbnails/{image,pdf,office,text}-thumbnail.tsx.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icons } from "@/components/icons";
import { authenticatedFetch } from "@/lib/auth";
import type { DriveApiPreview } from "./api";

const MAX_CONCURRENT_THUMBNAIL_LOADS = 6;
let activeThumbnailLoads = 0;
const pendingThumbnailLoads: ThumbnailLoadJob[] = [];

interface ThumbnailLoadJob {
  readonly run: () => void;
}

interface FileThumbnailProps {
  readonly objectId: string;
  readonly name: string;
  readonly mimeType?: string | undefined;
  readonly preview?: DriveApiPreview | undefined;
  readonly aspectRatio?: string;
  readonly icon?: keyof typeof Icons;
  readonly color?: string;
  readonly fallback?: ReactNode;
}

export function FileThumbnail({
  objectId,
  name,
  mimeType,
  preview,
  aspectRatio = "4 / 3",
  icon = "Doc",
  color = "var(--text-3)",
  fallback,
}: FileThumbnailProps) {
  const Icon = Icons[icon];
  const fallbackNode = fallback ?? <Icon size={36} />;
  const previewRef = useRef<HTMLDivElement | null>(null);
  const shouldLoadPreview = usePreviewVisibility(previewRef);
  const content = previewContent(
    objectId,
    name,
    mimeType,
    preview,
    fallbackNode,
    shouldLoadPreview,
  );
  return (
    <div
      ref={previewRef}
      aria-label={`Preview of ${name}`}
      style={{
        aspectRatio,
        background: "var(--surface-2)",
        display: "grid",
        placeItems: "center",
        color,
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
        position: "relative",
        width: "100%",
      }}
    >
      {content ?? fallbackNode}
    </div>
  );
}

function previewContent(
  objectId: string,
  name: string,
  mimeType: string | undefined,
  preview: DriveApiPreview | undefined,
  fallbackNode: ReactNode,
  shouldLoadPreview: boolean,
): ReactNode | null {
  const htmlPreviewKind = inferOfficeHtmlPreviewKind(name, mimeType);
  if (preview !== undefined && preview.status !== "available" && htmlPreviewKind === null) {
    return null;
  }
  const inferredKind =
    preview?.status === "available" ? preview.kind : inferBrowserPreviewKind(name, mimeType);
  if (inferredKind === "image") {
    if (!shouldLoadPreview) {
      return null;
    }
    const src = preview?.url ?? `/api/drive/objects/${objectId}/preview`;
    return (
      <>
        {fallbackNode}
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
            background: "var(--surface)",
          }}
        />
      </>
    );
  }
  if (inferredKind === "pdf" || inferredKind === "office") {
    const src = preview?.url ?? `/api/drive/objects/${objectId}/preview`;
    return (
      <PdfFirstPageThumbnail
        src={src}
        name={name}
        fallbackNode={fallbackNode}
        shouldLoad={shouldLoadPreview}
      />
    );
  }
  if (htmlPreviewKind !== null) {
    return (
      <HtmlPreviewThumbnail
        src={`/api/drive/objects/${objectId}/preview`}
        kind={htmlPreviewKind}
        name={name}
        fallbackNode={fallbackNode}
        shouldLoad={shouldLoadPreview}
      />
    );
  }
  if (preview?.kind === "text" && preview.text !== undefined) {
    const nativeKind = nativeTextPreviewKind(preview.mimeType || mimeType);
    if (nativeKind !== null) {
      return <NativeTextPreviewThumbnail kind={nativeKind} name={name} text={preview.text} />;
    }
    return (
      <pre
        aria-hidden="true"
        style={{
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
          margin: 0,
          padding: 10,
          overflow: "hidden",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: "var(--text-2)",
          fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
          fontSize: "10px",
          lineHeight: 1.35,
          background: "var(--surface)",
        }}
      >
        {preview.text.slice(0, 900)}
      </pre>
    );
  }
  return null;
}

function nativeTextPreviewKind(
  mimeType: string | undefined,
): "document" | "spreadsheet" | "presentation" | null {
  switch ((mimeType ?? "").toLowerCase()) {
    case "application/vnd.helix.document":
      return "document";
    case "application/vnd.helix.spreadsheet":
      return "spreadsheet";
    case "application/vnd.helix.presentation":
      return "presentation";
    default:
      return null;
  }
}

function NativeTextPreviewThumbnail({
  kind,
  name,
  text,
}: {
  readonly kind: "document" | "spreadsheet" | "presentation";
  readonly name: string;
  readonly text: string;
}) {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const title = lines[0] ?? null;
  const body = lines.slice(1);
  return (
    <div
      aria-label={`Rendered preview of ${name}`}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        overflow: "hidden",
        background: "var(--surface)",
        color: "var(--text)",
      }}
    >
      {kind === "spreadsheet" ? (
        <MiniSpreadsheet rows={nativeSpreadsheetRows(lines)} />
      ) : kind === "presentation" ? (
        <MiniPresentation title={title} lines={body} />
      ) : (
        <MiniDocument title={title} lines={body} />
      )}
    </div>
  );
}

function nativeSpreadsheetRows(lines: readonly string[]): readonly (readonly string[])[] {
  return lines.slice(0, 9).map((line) =>
    line
      .split("\t")
      .map((cell) => cell.trim())
      .slice(0, 6),
  );
}

function usePreviewVisibility(ref: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (visible || typeof IntersectionObserver === "undefined") {
      return undefined;
    }
    const element = ref.current;
    if (element === null) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, visible]);

  return visible;
}

function runBoundedThumbnailLoad<T>(
  signal: AbortSignal,
  task: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const job: ThumbnailLoadJob = {
      run: () => {
        if (signal.aborted) {
          completeThumbnailLoad();
          reject(abortError());
          return;
        }
        task()
          .then(resolve, reject)
          .finally(completeThumbnailLoad);
      },
    };

    pendingThumbnailLoads.push(job);
    signal.addEventListener(
      "abort",
      () => {
        const index = pendingThumbnailLoads.indexOf(job);
        if (index >= 0) {
          pendingThumbnailLoads.splice(index, 1);
          reject(abortError());
        }
      },
      { once: true },
    );
    drainThumbnailLoadQueue();
  });
}

function drainThumbnailLoadQueue(): void {
  while (
    activeThumbnailLoads < MAX_CONCURRENT_THUMBNAIL_LOADS &&
    pendingThumbnailLoads.length > 0
  ) {
    const job = pendingThumbnailLoads.shift();
    if (job === undefined) {
      return;
    }
    activeThumbnailLoads += 1;
    job.run();
  }
}

function completeThumbnailLoad(): void {
  activeThumbnailLoads = Math.max(0, activeThumbnailLoads - 1);
  drainThumbnailLoadQueue();
}

function abortError(): DOMException {
  return new DOMException("Thumbnail preview load aborted.", "AbortError");
}

function inferBrowserPreviewKind(
  name: string,
  mimeType: string | undefined,
): "image" | "pdf" | null {
  const normalizedMime = (mimeType ?? "").toLowerCase();
  if (normalizedMime === "application/pdf") {
    return "pdf";
  }
  if (
    normalizedMime === "image/png" ||
    normalizedMime === "image/jpeg" ||
    normalizedMime === "image/gif" ||
    normalizedMime === "image/webp" ||
    normalizedMime === "image/svg+xml" ||
    normalizedMime === "image/avif" ||
    normalizedMime === "image/bmp" ||
    normalizedMime === "image/x-ms-bmp" ||
    normalizedMime === "image/heic" ||
    normalizedMime === "image/heif" ||
    normalizedMime === "image/jp2" ||
    normalizedMime === "image/jpx" ||
    normalizedMime === "image/jpm" ||
    normalizedMime === "image/jxl" ||
    normalizedMime === "image/tiff" ||
    normalizedMime === "image/vnd.adobe.photoshop"
  ) {
    return "image";
  }

  const ext = extensionFromName(name);
  if (ext === "pdf") {
    return "pdf";
  }
  if (
    ext === "png" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "gif" ||
    ext === "webp" ||
    ext === "svg" ||
    ext === "avif" ||
    ext === "bmp" ||
    ext === "dib" ||
    ext === "heic" ||
    ext === "heif" ||
    ext === "jp2" ||
    ext === "j2k" ||
    ext === "jpf" ||
    ext === "jpx" ||
    ext === "jpm" ||
    ext === "jxl" ||
    ext === "tif" ||
    ext === "tiff" ||
    ext === "psd"
  ) {
    return "image";
  }
  return null;
}

function extensionFromName(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) {
    return null;
  }
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/i.test(ext) ? ext : null;
}

function inferOfficeHtmlPreviewKind(
  name: string,
  mimeType: string | undefined,
): "document" | "spreadsheet" | "presentation" | null {
  const normalizedMime = (mimeType ?? "").toLowerCase();
  if (normalizedMime.includes("wordprocessingml")) {
    return "document";
  }
  if (
    normalizedMime.includes("spreadsheetml") ||
    normalizedMime === "application/vnd.ms-excel" ||
    normalizedMime === "application/vnd.oasis.opendocument.spreadsheet"
  ) {
    return "spreadsheet";
  }
  if (
    normalizedMime.includes("presentationml") ||
    normalizedMime === "application/vnd.ms-powerpoint"
  ) {
    return "presentation";
  }

  const ext = extensionFromName(name);
  if (ext === "docx" || ext === "docm" || ext === "dotx" || ext === "dotm") {
    return "document";
  }
  if (
    ext === "xlsx" ||
    ext === "xlsm" ||
    ext === "xltx" ||
    ext === "xltm" ||
    ext === "xls" ||
    ext === "xlsb" ||
    ext === "ods"
  ) {
    return "spreadsheet";
  }
  if (
    ext === "pptx" ||
    ext === "pptm" ||
    ext === "ppsx" ||
    ext === "ppsm" ||
    ext === "potx" ||
    ext === "potm"
  ) {
    return "presentation";
  }
  return null;
}

function HtmlPreviewThumbnail({
  src,
  kind,
  name,
  fallbackNode,
  shouldLoad,
}: {
  readonly src: string;
  readonly kind: "document" | "spreadsheet" | "presentation";
  readonly name: string;
  readonly fallbackNode: ReactNode;
  readonly shouldLoad: boolean;
}) {
  const [preview, setPreview] = useState<HtmlThumbnailModel | null>(null);

  useEffect(() => {
    if (!shouldLoad) {
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();

    async function loadPreview() {
      try {
        const rendered = await runBoundedThumbnailLoad(controller.signal, () =>
          loadHtmlThumbnail(src, kind),
        );
        if (!cancelled) {
          setPreview(rendered);
        }
      } catch (error) {
        if (!cancelled) {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            setPreview(null);
          }
        }
      }
    }

    void loadPreview();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [kind, shouldLoad, src]);

  return (
    <>
      {fallbackNode}
      {preview === null ? null : (
        <div
          aria-label={`Rendered preview of ${name}`}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--surface)",
            color: "var(--text)",
          }}
        >
          {preview.kind === "spreadsheet" ? (
            <MiniSpreadsheet rows={preview.rows} />
          ) : preview.kind === "presentation" ? (
            <MiniPresentation title={preview.title} lines={preview.lines} />
          ) : (
            <MiniDocument title={preview.title} lines={preview.lines} />
          )}
        </div>
      )}
    </>
  );
}

type HtmlThumbnailModel =
  | {
      readonly kind: "document";
      readonly title: string | null;
      readonly lines: readonly string[];
    }
  | {
      readonly kind: "spreadsheet";
      readonly rows: readonly (readonly string[])[];
    }
  | {
      readonly kind: "presentation";
      readonly title: string | null;
      readonly lines: readonly string[];
    };

async function loadHtmlThumbnail(
  src: string,
  kind: "document" | "spreadsheet" | "presentation",
): Promise<HtmlThumbnailModel> {
  const response = await authenticatedFetch(src);
  if (!response.ok) {
    throw new Error(`HTML preview failed with status ${String(response.status)}`);
  }
  const html = await response.text();
  const document = new DOMParser().parseFromString(html, "text/html");
  if (kind === "spreadsheet") {
    return { kind, rows: extractTableRows(document) };
  }
  if (kind === "presentation") {
    return extractPresentationLines(document);
  }
  return extractDocumentLines(document);
}

function extractDocumentLines(document: Document): HtmlThumbnailModel {
  const root = document.querySelector("main .doc") ?? document.body;
  const title = textFromNode(root.querySelector("h1,h2,h3"));
  const lineNodes = [...root.querySelectorAll("h1,h2,h3,p,li,blockquote,td")]
    .map(textFromNode)
    .filter((line) => line.length > 0);
  const lines = dedupeStrings(lineNodes).slice(0, 12);
  if (lines.length === 0) {
    const bodyText = textFromNode(root);
    return {
      kind: "document",
      title,
      lines: bodyText.length === 0 ? [] : bodyText.split(/\s{2,}|\n+/u).slice(0, 12),
    };
  }
  return { kind: "document", title, lines };
}

function extractPresentationLines(document: Document): HtmlThumbnailModel {
  const firstSlide =
    document.querySelector("main .doc .slide-card") ?? document.querySelector(".slide-card");
  const root = firstSlide ?? document.querySelector("main .doc") ?? document.body;
  const title = textFromNode(root.querySelector("h1,h2,h3"));
  const lines = [...root.querySelectorAll("li,p")]
    .map(textFromNode)
    .filter((line) => line.length > 0)
    .slice(0, 8);
  if (lines.length === 0) {
    const bodyText = textFromNode(root);
    return {
      kind: "presentation",
      title,
      lines: bodyText.length === 0 ? [] : bodyText.split(/\s{2,}|\n+/u).slice(0, 8),
    };
  }
  return { kind: "presentation", title, lines };
}

function extractTableRows(document: Document): readonly (readonly string[])[] {
  const table = document.querySelector("main .doc table") ?? document.querySelector("table");
  if (table === null) {
    const lines = textFromNode(document.querySelector("main .doc") ?? document.body)
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 8);
    return lines.map((line) => [line]);
  }
  return [...table.querySelectorAll("tr")]
    .slice(0, 9)
    .map((row) =>
      [...row.querySelectorAll("th,td")]
        .slice(0, 6)
        .map(textFromNode),
    )
    .filter((row) => row.some((cell) => cell.length > 0));
}

function textFromNode(node: Element | null): string {
  return (node?.textContent ?? "").replace(/\s+/gu, " ").trim();
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function MiniDocument({
  title,
  lines,
}: {
  readonly title: string | null;
  readonly lines: readonly string[];
}) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        padding: 12,
        display: "grid",
        alignContent: "start",
        gap: 5,
        background: "white",
        color: "#1f2937",
      }}
    >
      {title !== null && title.length > 0 ? (
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            lineHeight: 1.2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
      ) : null}
      {lines.map((line, index) => (
        <div
          key={`${line}-${String(index)}`}
          style={{
            fontSize: 8,
            lineHeight: 1.25,
            color: index === 0 && title === null ? "#111827" : "#4b5563",
            fontWeight: index === 0 && title === null ? 650 : 400,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

function MiniPresentation({
  title,
  lines,
}: {
  readonly title: string | null;
  readonly lines: readonly string[];
}) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        padding: 12,
        background: "linear-gradient(135deg, #f97316, #7c3aed)",
        color: "white",
        display: "grid",
        alignContent: "end",
        gap: 5,
      }}
    >
      {title !== null && title.length > 0 ? (
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.15,
            fontWeight: 750,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {title}
        </div>
      ) : null}
      {lines.slice(0, 4).map((line, index) => (
        <div
          key={`${line}-${String(index)}`}
          style={{
            fontSize: 8,
            lineHeight: 1.2,
            opacity: 0.86,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

function MiniSpreadsheet({ rows }: { readonly rows: readonly (readonly string[])[] }) {
  const visibleRows = rows.length === 0 ? [[""]] : rows;
  return (
    <div
      aria-hidden="true"
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        padding: 10,
        background: "#f8fafc",
        display: "grid",
        alignContent: "start",
      }}
    >
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          background: "white",
          fontSize: 8,
          lineHeight: 1.2,
          color: "#1f2937",
        }}
      >
        <tbody>
          {visibleRows.map((row, rowIndex) => (
            <tr key={`row-${String(rowIndex)}`}>
              {(row.length === 0 ? [""] : row).map((cell, cellIndex) => (
                <td
                  key={`cell-${String(rowIndex)}-${String(cellIndex)}`}
                  style={{
                    border: "1px solid #e5e7eb",
                    padding: "3px 4px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontWeight: rowIndex === 0 ? 650 : 400,
                    background: rowIndex === 0 ? "#f1f5f9" : "white",
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PdfFirstPageThumbnail({
  src,
  name,
  fallbackNode,
  shouldLoad,
}: {
  readonly src: string;
  readonly name: string;
  readonly fallbackNode: ReactNode;
  readonly shouldLoad: boolean;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!shouldLoad) {
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();

    async function renderThumbnail() {
      try {
        const rendered = await runBoundedThumbnailLoad(controller.signal, () =>
          renderPdfFirstPageThumbnail(src),
        );
        if (!cancelled) {
          setDataUrl(rendered);
        }
      } catch (error) {
        if (!cancelled) {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            setDataUrl(null);
          }
        }
      }
    }

    void renderThumbnail();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [shouldLoad, src]);

  return (
    <>
      {fallbackNode}
      {dataUrl === null ? null : (
        <img
          src={dataUrl}
          alt=""
          loading="lazy"
          aria-label={`Rendered first page of ${name}`}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
            background: "white",
          }}
        />
      )}
    </>
  );
}

interface PdfJsModule {
  readonly GlobalWorkerOptions?: {
    workerSrc: string;
  };
  readonly VerbosityLevel?: {
    readonly ERRORS: number;
  };
  readonly getDocument: (source: { readonly data: Uint8Array; readonly verbosity?: number }) => {
    readonly promise: Promise<PdfJsDocument>;
  };
}

interface PdfJsDocument {
  readonly getPage: (pageNumber: number) => Promise<PdfJsPage>;
  readonly destroy?: () => Promise<void> | void;
}

interface PdfJsPage {
  readonly getViewport: (options: { readonly scale: number }) => PdfJsViewport;
  readonly render: (params: {
    readonly canvasContext: CanvasRenderingContext2D;
    readonly viewport: PdfJsViewport;
  }) => {
    readonly promise: Promise<void>;
  };
}

interface PdfJsViewport {
  readonly width: number;
  readonly height: number;
}

async function renderPdfFirstPageThumbnail(src: string): Promise<string> {
  const response = await authenticatedFetch(src);
  if (!response.ok) {
    throw new Error(`PDF preview failed with status ${String(response.status)}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({
    data: bytes,
    verbosity: pdfjs.VerbosityLevel?.ERRORS ?? 0,
  }).promise;
  try {
    const page = await pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1, 360 / Math.max(1, baseViewport.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("Canvas 2D context is unavailable.");
    }
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas.toDataURL("image/png");
  } finally {
    await pdf.destroy?.();
  }
}

async function loadPdfJs(): Promise<PdfJsModule> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  const pdfjsModule = pdfjs as unknown as PdfJsModule;
  if (pdfjsModule.GlobalWorkerOptions !== undefined) {
    pdfjsModule.GlobalWorkerOptions.workerSrc = (worker as { readonly default: string }).default;
  }
  return pdfjsModule;
}
