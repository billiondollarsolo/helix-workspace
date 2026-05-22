/* SlideThumb — a 16:9 mini render of a slide for the editor thumbnail strip.
   Ported from the design handoff (app-slides.jsx → SlideThumb): gradient for
   title slides, striped lines for content slides.

   When `onMoveUp` / `onMoveDown` are supplied (backend decks), small reorder
   controls appear on hover and drive the `slides.slide.reorder` tool. */

import { useState, type CSSProperties } from "react";
import { Icons } from "@/components/icons";
import type { Slide } from "./seed";

interface SlideThumbProps {
  readonly slide: Slide;
  readonly index: number;
  readonly active: boolean;
  readonly onSelect: () => void;
  /** Move this slide one position earlier; omitted when it is already first. */
  readonly onMoveUp?: (() => void) | undefined;
  /** Move this slide one position later; omitted when it is already last. */
  readonly onMoveDown?: (() => void) | undefined;
}

/** Resolve the mini-render background for a slide. */
function thumbBackground(slide: Slide): string {
  if (slide.layout === "title" && slide.bg === "accent") {
    return "linear-gradient(135deg, var(--accent), var(--accent-2))";
  }
  if (slide.layout === "title" && slide.bg === "neutral") {
    return "var(--surface-3)";
  }
  return "var(--surface)";
}

/** Whether the mini render uses a colored (accent) background. */
function isColoredThumb(slide: Slide): boolean {
  return slide.layout === "title" && slide.bg === "accent";
}

/** Short secondary text shown under the mini title, if any. */
function thumbSubtitle(slide: Slide): string | undefined {
  if (slide.layout === "title") {
    return slide.subtitle;
  }
  if (slide.layout === "stats") {
    return slide.subtitle;
  }
  return undefined;
}

/** Striped line widths for content slides (agenda / bullets). */
function thumbLineWidths(slide: Slide): readonly number[] {
  if (slide.layout === "agenda" || slide.layout === "bullets") {
    return slide.items.slice(0, 3).map((_, i) => 60 + i * 10);
  }
  return [];
}

const moveButtonStyle: CSSProperties = {
  width: 16,
  height: 14,
  display: "grid",
  placeItems: "center",
  padding: 0,
  border: "1px solid var(--border)",
  borderRadius: 3,
  background: "var(--surface)",
  cursor: "pointer",
  color: "var(--text-2)",
};

export function SlideThumb({
  slide,
  index,
  active,
  onSelect,
  onMoveUp,
  onMoveDown,
}: SlideThumbProps) {
  const [hovered, setHovered] = useState(false);
  const colored = isColoredThumb(slide);
  const subtitle = thumbSubtitle(slide);
  const lines = thumbLineWidths(slide);
  const reorderable = onMoveUp !== undefined || onMoveDown !== undefined;

  const rowBackground = active
    ? "var(--accent-soft)"
    : hovered
      ? "var(--hover)"
      : "transparent";

  const renderStyle: CSSProperties = {
    flex: 1,
    aspectRatio: "16 / 9",
    background: thumbBackground(slide),
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    borderRadius: 4,
    padding: 4,
    fontSize: 5,
    lineHeight: 1.3,
    color: colored ? "rgba(255,255,255,0.9)" : "var(--text-2)",
    overflow: "hidden",
  };

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        gap: 8,
        padding: 6,
        width: "100%",
        borderRadius: 6,
        background: rowBackground,
        position: "relative",
      }}
    >
      <span
        style={{
          width: 18,
          paddingTop: 4,
          fontSize: 11,
          color: "var(--text-3)",
          flexShrink: 0,
          fontVariantNumeric: "tabular-nums",
          textAlign: "right",
        }}
      >
        {index + 1}
      </span>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        aria-label={`Slide ${String(index + 1)}: ${slide.title}`}
        style={{
          flex: 1,
          display: "flex",
          padding: 0,
          textAlign: "left",
          border: "none",
          background: "transparent",
          cursor: "pointer",
        }}
      >
        <div style={renderStyle}>
          <div
            className="truncate"
            style={{ fontWeight: 700, fontSize: 6, marginBottom: 2 }}
          >
            {slide.title}
          </div>
          {subtitle ? (
            <div className="truncate" style={{ opacity: 0.7 }}>
              {subtitle}
            </div>
          ) : null}
          {lines.map((width) => (
            <div
              key={`stripe-${String(width)}`}
              style={{
                height: 1.5,
                background: "currentColor",
                opacity: 0.4,
                marginTop: 2,
                width: `${String(width)}%`,
              }}
            />
          ))}
        </div>
      </button>
      {reorderable && (hovered || active) ? (
        <div
          style={{
            position: "absolute",
            right: 8,
            top: 8,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <button
            type="button"
            aria-label={`Move slide ${String(index + 1)} up`}
            disabled={onMoveUp === undefined}
            onClick={(event) => {
              event.stopPropagation();
              onMoveUp?.();
            }}
            style={{ ...moveButtonStyle, opacity: onMoveUp === undefined ? 0.35 : 1 }}
          >
            <Icons.ChevronDown size={10} style={{ transform: "rotate(180deg)" }} />
          </button>
          <button
            type="button"
            aria-label={`Move slide ${String(index + 1)} down`}
            disabled={onMoveDown === undefined}
            onClick={(event) => {
              event.stopPropagation();
              onMoveDown?.();
            }}
            style={{ ...moveButtonStyle, opacity: onMoveDown === undefined ? 0.35 : 1 }}
          >
            <Icons.ChevronDown size={10} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
