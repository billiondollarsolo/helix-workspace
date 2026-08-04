/* Video viewer — native HTML5 `<video controls>` over a Drive object URL.
 *
 * Same streaming strategy as ImportedAudioRenderer. The browser handles
 * range requests, codec negotiation, and seeking. For unsupported codecs
 * (e.g. .mov on some platforms) the user sees the controls but no frames —
 * Download remains available.
 */

import type { ImportedVideo } from "../parsers/types.js";
import { driveDownloadHref, formatBytes } from "./viewer-shared";

export interface ImportedVideoRendererProps {
  readonly video: ImportedVideo;
  readonly objectId: string;
  readonly fileName?: string;
}

export function ImportedVideoRenderer({ video, objectId, fileName }: ImportedVideoRendererProps) {
  const src = `/api/drive/objects/${objectId}/content`;
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
        <strong>{fileName ?? "Video"}</strong>
        <span style={{ color: "var(--text-3)", fontSize: "var(--text-caption)" }}>
          {video.format.label} · {formatBytes(video.bytes.byteLength)}
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
          background: "#000",
          padding: 16,
        }}
      >
        <video
          controls
          src={src}
          preload="metadata"
          style={{ maxWidth: "100%", maxHeight: "100%", outline: "none" }}
          aria-label={fileName ?? "Video playback"}
        >
          Your browser does not support video playback.
        </video>
      </div>
    </div>
  );
}
