/* Plain image viewer — wraps the bytes in a blob URL and renders inline.
 *
 * Used for JPEG / PNG / GIF / WebP / SVG. Same chrome as the other imported
 * viewers (banner + download). v2 could add zoom/pan and exif metadata.
 */

import { useEffect, useState } from "react";
import type { ImportedImage } from "../parsers/types.js";
import { driveDownloadHref, formatBytes } from "./viewer-shared";

export interface ImportedImageRendererProps {
  readonly image: ImportedImage;
  readonly objectId: string;
  readonly fileName?: string;
}

export function ImportedImageRenderer({ image, objectId, fileName }: ImportedImageRendererProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const blob = new Blob([image.bytes], { type: image.mimeType });
    const obj = URL.createObjectURL(blob);
    setUrl(obj);
    return () => {
      URL.revokeObjectURL(obj);
    };
  }, [image.bytes, image.mimeType]);

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
        <strong>{fileName ?? "Image"}</strong>
        <span style={{ color: "var(--text-3)", fontSize: "var(--text-caption)" }}>
          {image.format.label} · {formatBytes(image.bytes.byteLength)}
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
          overflow: "auto",
          padding: 16,
        }}
      >
        {url !== null ? (
          <img
            src={url}
            alt={fileName ?? ""}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          />
        ) : null}
      </div>
    </div>
  );
}
