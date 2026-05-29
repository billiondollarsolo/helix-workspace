/* Renders an ImportedDeck (slides extracted from .pptx etc.) as a vertical
 * slide list — left rail of slide thumbnails, right pane showing the active
 * slide's title + body + speaker notes. Read-only in v1.
 */

import { useState } from "react";
import type { ImportedDeck, ImportedSlide } from "../parsers/types.js";

export interface ImportedDeckRendererProps {
  readonly deck: ImportedDeck;
  readonly objectId: string;
  readonly fileName?: string;
}

export function ImportedDeckRenderer({ deck, objectId, fileName }: ImportedDeckRendererProps) {
  const [activeSlideId, setActiveSlideId] = useState(deck.slides[0]?.id ?? "");
  const activeSlide = deck.slides.find((s) => s.id === activeSlideId) ?? deck.slides[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <ImportedBanner
        label={deck.format.label}
        objectId={objectId}
        fileName={fileName}
        warnings={deck.warnings}
      />
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "240px 1fr", minHeight: 0 }}>
        <aside
          aria-label="Slide thumbnails"
          style={{
            borderRight: "1px solid var(--border)",
            background: "var(--surface-2)",
            overflowY: "auto",
            padding: 12,
          }}
        >
          {deck.slides.map((slide, idx) => (
            <button
              key={slide.id}
              type="button"
              onClick={() => setActiveSlideId(slide.id)}
              aria-current={slide.id === activeSlideId ? "page" : undefined}
              style={{
                display: "block",
                width: "100%",
                marginBottom: 8,
                padding: 12,
                textAlign: "left",
                background: slide.id === activeSlideId ? "var(--accent-soft)" : "var(--surface)",
                border: `1px solid ${slide.id === activeSlideId ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", marginBottom: 4 }}>
                Slide {idx + 1}
              </div>
              <div
                style={{
                  fontSize: "var(--text-body)",
                  fontWeight: 500,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {slide.title}
              </div>
            </button>
          ))}
        </aside>
        <main
          style={{
            overflowY: "auto",
            background: "var(--bg)",
            padding: 32,
          }}
        >
          {activeSlide ? <SlideCanvas slide={activeSlide} /> : (
            <div style={{ textAlign: "center", color: "var(--text-3)", marginTop: 64 }}>
              Empty deck
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function SlideCanvas({ slide }: { readonly slide: ImportedSlide }) {
  return (
    <article
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "var(--shadow-md)",
        padding: "48px 64px",
        maxWidth: 900,
        margin: "0 auto",
        aspectRatio: "16 / 9",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <h1 style={{ fontSize: 32, fontWeight: 600, margin: 0 }}>{slide.title}</h1>
      <div
        style={{
          marginTop: 24,
          flex: 1,
          fontSize: 18,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          color: "var(--text)",
        }}
      >
        {slide.bodyText}
      </div>
      {slide.notes !== undefined && slide.notes.length > 0 ? (
        <aside
          aria-label="Speaker notes"
          style={{
            marginTop: 24,
            padding: 16,
            borderTop: "1px dashed var(--border)",
            fontSize: "var(--text-caption)",
            color: "var(--text-2)",
            whiteSpace: "pre-wrap",
          }}
        >
          <strong style={{ display: "block", marginBottom: 4 }}>Speaker notes</strong>
          {slide.notes}
        </aside>
      ) : null}
    </article>
  );
}

function ImportedBanner({
  label,
  objectId,
  fileName,
  warnings,
}: {
  readonly label: string;
  readonly objectId: string;
  readonly fileName?: string;
  readonly warnings: ReadonlyArray<string>;
}) {
  return (
    <div
      role="status"
      style={{
        padding: "12px 24px",
        background: "var(--info-soft, var(--surface-2))",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <strong>Imported from {label}</strong>
      {fileName !== undefined ? (
        <span style={{ marginLeft: 8, color: "var(--text-2)" }}>
          <code>{fileName}</code>
        </span>
      ) : null}
      <a
        href={`/api/drive/objects/${objectId}/content?download=1`}
        className="btn sm"
        style={{ marginLeft: 12 }}
        download={fileName ?? ""}
      >
        Download original
      </a>
      {warnings.length > 0 ? (
        <p
          style={{
            margin: "4px 0 0 0",
            fontSize: "var(--text-caption)",
            color: "var(--text-2)",
            lineHeight: 1.4,
          }}
        >
          {warnings[0]}
        </p>
      ) : null}
    </div>
  );
}
