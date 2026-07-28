/* Renders a document parsed by the universal loader (e.g. from .docx / .md /
 * .txt / .html). Mounts a read-write TipTap editor pre-populated with the
 * imported TipTap JSON, plus a warning banner explaining the import source +
 * any fidelity caveats from the parser.
 *
 * Save semantics in v1: edits are local-only (the editor is mounted detached
 * from the helix-doc native session). A "Save as helix doc" CTA next to the
 * banner will be wired in the format-pipeline phase to call docs.import and
 * convert this Drive blob into a new helix-native document.
 */

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { ImportedDoc } from "../parsers/types.js";

export interface ImportedDocumentRendererProps {
  readonly doc: ImportedDoc;
  readonly objectId: string;
  readonly fileName?: string;
}

export function ImportedDocumentRenderer({
  doc,
  objectId,
  fileName,
}: ImportedDocumentRendererProps) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: doc.tiptapDoc as never,
    editable: doc.readOnly !== true,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <ImportedDocumentBanner doc={doc} objectId={objectId} fileName={fileName} />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          background: "var(--bg)",
          padding: "24px 0",
        }}
      >
        <div
          style={{
            maxWidth: 820,
            margin: "0 auto",
            padding: "48px 64px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            minHeight: 600,
          }}
        >
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}

function ImportedDocumentBanner({
  doc,
  objectId,
  fileName,
}: {
  readonly doc: ImportedDoc;
  readonly objectId: string;
  readonly fileName?: string;
}) {
  return (
    <div
      role="status"
      style={{
        padding: "12px 24px",
        background: "var(--info-soft, var(--surface-2))",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: 1, minWidth: 240 }}>
        <strong style={{ fontSize: "var(--text-body)" }}>Imported from {doc.format.label}</strong>
        {fileName !== undefined ? (
          <span style={{ marginLeft: 8, color: "var(--text-2)", fontSize: "var(--text-caption)" }}>
            <code>{fileName}</code>
          </span>
        ) : null}
        {doc.warnings.length > 0 ? (
          <div
            style={{
              margin: "4px 0 0 0",
              fontSize: "var(--text-caption)",
              color: "var(--text-2)",
              lineHeight: 1.4,
            }}
          >
            <span>{doc.warnings[0]}</span>
            {doc.warnings.length > 1 ? (
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: "pointer" }}>
                  +{doc.warnings.length - 1} more
                </summary>
                <ul
                  style={{
                    marginTop: 8,
                    paddingLeft: 20,
                    fontSize: "var(--text-caption)",
                  }}
                >
                  {doc.warnings.slice(1).map((w, idx) => (
                    <li key={`warning-${String(idx)}`}>{w}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
      <a
        href={`/api/drive/objects/${objectId}/content?download=1`}
        className="btn sm"
        download={fileName ?? ""}
      >
        Download original
      </a>
    </div>
  );
}
