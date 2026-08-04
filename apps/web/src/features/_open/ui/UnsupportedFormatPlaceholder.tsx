/* Shown when the universal loader can't render a Drive file natively.
 *
 * Mirrors what Google Drive / OneDrive do for formats they can't preview:
 * a clean card with the format label, size, a download primary action, and
 * a suggested-companion-app hint when applicable (e.g. "Open in OneNote
 * to view this .one file").
 */

import type { UnsupportedFormat } from "../parsers/types.js";
import { driveDownloadHref, formatBytes } from "./viewer-shared";

export interface UnsupportedFormatPlaceholderProps {
  readonly result: UnsupportedFormat;
  readonly objectId: string;
  /** Optional name override — when the loader knew the filename, pass it. */
  readonly fileName?: string;
  /** Optional file size for the metadata row. */
  readonly byteSize?: number;
}

interface FormatHint {
  readonly icon: string;
  readonly recommendedApp?: string;
  /** True when client-side parsing is in our roadmap (renders the tracking ref). */
  readonly inProgress?: boolean;
}

const FORMAT_HINTS: Record<string, FormatHint> = {
  // Microsoft proprietary — no JS parser exists; need the native app.
  "ms-onenote": { icon: "📒", recommendedApp: "Microsoft OneNote" },
  "ms-access": { icon: "🗄️", recommendedApp: "Microsoft Access" },
  "ms-visio": { icon: "📐", recommendedApp: "Microsoft Visio" },
  "ms-publisher": { icon: "📰", recommendedApp: "Microsoft Publisher" },
  "ms-project": { icon: "📊", recommendedApp: "Microsoft Project" },
  "ms-msg": { icon: "📧", recommendedApp: "Microsoft Outlook" },
  "ms-pst": { icon: "📥", recommendedApp: "Microsoft Outlook" },
  "ms-ost": { icon: "📥", recommendedApp: "Microsoft Outlook" },
  "ms-chm": { icon: "❓", recommendedApp: "a CHM reader" },
  "ms-xps": { icon: "📄", recommendedApp: "an XPS viewer" },
  "ms-thmx": { icon: "🎨", recommendedApp: "Microsoft Office" },
  "ms-works": { icon: "📊", recommendedApp: "Microsoft Works" },
  "ms-ppsx": { icon: "🎬", inProgress: true },
  "ms-ppsm": { icon: "🎬", inProgress: true },
  "ms-xlt": { icon: "📊", inProgress: true },

  // Books.
  epub: { icon: "📚", recommendedApp: "an EPUB reader" },
  mobi: { icon: "📚", recommendedApp: "Kindle" },
  ibooks: { icon: "📚", recommendedApp: "Apple Books" },

  // ODF beyond text/sheets/slides.
  "odf-flat": { icon: "📝", inProgress: true },
  odg: { icon: "🎨", recommendedApp: "LibreOffice Draw" },
  odb: { icon: "🗄️", recommendedApp: "LibreOffice Base" },
  "odf-formula": { icon: "🧮", recommendedApp: "LibreOffice Math" },
  oxt: { icon: "🧩", recommendedApp: "LibreOffice / OpenOffice" },

  // CAD / design.
  solidworks: { icon: "🛠️", recommendedApp: "SolidWorks" },
  indesign: { icon: "📐", recommendedApp: "Adobe InDesign" },
  framemaker: { icon: "📐", recommendedApp: "Adobe FrameMaker" },

  // International word processors.
  hwp: { icon: "📝", recommendedApp: "Hancom Office" },
  wordperfect: { icon: "📝", recommendedApp: "Corel WordPerfect" },

  // Legacy spreadsheets.
  "quattro-pro": { icon: "📊", recommendedApp: "Corel Quattro Pro" },
  dbase: { icon: "🗄️", recommendedApp: "a dBase-compatible tool" },
  dif: { icon: "📊", inProgress: true },

  // Archives.
  "archive-zip": { icon: "🗜️" },
  "archive-gz": { icon: "🗜️" },
  "archive-tar": { icon: "🗜️" },

  // Niche images Chrome can't render.
  "image-emf": { icon: "🖼️", recommendedApp: "Windows or Inkscape" },
  "image-wmf": { icon: "🖼️", recommendedApp: "Windows or Inkscape" },
  "image-jp2": { icon: "🖼️", inProgress: true },
  "image-jb2": { icon: "🖼️", recommendedApp: "a JBIG2 viewer" },
  "image-bpg": { icon: "🖼️", recommendedApp: "the libbpg viewer" },
  "image-ppm": { icon: "🖼️", inProgress: true },
  "image-icns": { icon: "🖼️", recommendedApp: "macOS Preview" },
  "image-psd": { icon: "🖼️", recommendedApp: "Adobe Photoshop or GIMP" },

  // Legacy office binaries we don't natively parse yet but might.
  "doc-legacy": { icon: "📝", inProgress: true, recommendedApp: "Microsoft Word" },
  "ppt-legacy": { icon: "🎬", inProgress: true, recommendedApp: "Microsoft PowerPoint" },
};

export function UnsupportedFormatPlaceholder({
  result,
  objectId,
  fileName,
  byteSize,
}: UnsupportedFormatPlaceholderProps) {
  const { format, reason } = result;
  const hint = FORMAT_HINTS[format.id] ?? { icon: "📄" };
  const hasTrackingTask = format.trackingTask !== undefined;
  const inProgress = hint.inProgress === true || hasTrackingTask;
  const title = inProgress ? "Preview/download only" : "Preview not available";
  const sublabel = inProgress
    ? hint.recommendedApp
      ? `Editable conversion for ${format.label} is not available yet. Open this file in ${hint.recommendedApp}, or download the original.`
      : `Editable conversion for ${format.label} is not available yet. Download the original to keep working.`
    : hint.recommendedApp
      ? `To view this file, open it in ${hint.recommendedApp}.`
      : `Helix doesn't preview ${format.label} files in the browser yet.`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          padding: "8px 16px",
          background: "var(--surface-2)",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <strong>{fileName ?? format.label}</strong>
        <span style={{ color: "var(--text-3)", fontSize: "var(--text-caption)" }}>
          {format.label}
          {byteSize !== undefined ? ` · ${formatBytes(byteSize)}` : null}
        </span>
        <div style={{ flex: 1 }} />
        <a href={driveDownloadHref(objectId)} className="btn sm" download={fileName ?? ""}>
          Download
        </a>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg)",
          padding: 32,
        }}
      >
        <div
          role="status"
          style={{
            maxWidth: 520,
            padding: 36,
            border: "1px solid var(--border)",
            borderRadius: 12,
            background: "var(--surface)",
            textAlign: "center",
            boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
          }}
        >
          <div aria-hidden="true" style={{ fontSize: 56, marginBottom: 12, lineHeight: 1 }}>
            {hint.icon}
          </div>
          <h1 style={{ margin: 0, fontSize: "var(--text-h2)", fontWeight: 600 }}>{title}</h1>
          <p
            style={{
              marginTop: 12,
              color: "var(--text-2)",
              fontSize: "var(--text-body)",
              lineHeight: 1.5,
            }}
          >
            {sublabel}
          </p>
          <p
            style={{
              marginTop: 8,
              color: "var(--text-3)",
              fontSize: "var(--text-caption)",
              lineHeight: 1.5,
            }}
          >
            {reason}
          </p>

          <div
            style={{
              display: "flex",
              gap: 8,
              justifyContent: "center",
              marginTop: 24,
              flexWrap: "wrap",
            }}
          >
            <a href={driveDownloadHref(objectId)} className="btn primary" download={fileName ?? ""}>
              Download original
            </a>
          </div>

          {hasTrackingTask ? (
            <p
              style={{
                marginTop: 20,
                fontSize: "var(--text-caption)",
                color: "var(--text-3)",
              }}
            >
              Tracked under <code>{format.trackingTask}</code> in the helix-editors roadmap.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
