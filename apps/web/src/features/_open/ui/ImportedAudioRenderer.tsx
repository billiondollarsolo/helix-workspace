/* Audio viewer — native HTML5 `<audio controls>` over a Drive object URL.
 *
 * Streams directly from `/api/drive/objects/:id/content` (range-supported by
 * the server) so the browser handles seeking and large files without loading
 * everything into memory. The chrome (filename, format, size, download) mirrors
 * the other Imported*Renderer components for visual consistency.
 */

import type { ImportedAudio } from "../parsers/types.js";
import { driveDownloadHref, formatBytes } from "./viewer-shared";

export interface ImportedAudioRendererProps {
  readonly audio: ImportedAudio;
  readonly objectId: string;
  readonly fileName?: string;
}

export function ImportedAudioRenderer({ audio, objectId, fileName }: ImportedAudioRendererProps) {
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
        <strong>{fileName ?? "Audio"}</strong>
        <span style={{ color: "var(--text-3)", fontSize: "var(--text-caption)" }}>
          {audio.format.label} · {formatBytes(audio.bytes.byteLength)}
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
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg)",
          padding: 32,
          gap: 24,
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 96,
            height: 96,
            borderRadius: "50%",
            background:
              "linear-gradient(135deg, var(--accent, #6366f1) 0%, var(--accent-2, #ec4899) 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 40,
            color: "white",
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
          }}
        >
          ♪
        </div>
        <audio
          controls
          src={src}
          preload="metadata"
          style={{ width: "min(560px, 90%)" }}
          aria-label={fileName ?? "Audio playback"}
        >
          Your browser does not support audio playback.
        </audio>
      </div>
    </div>
  );
}
