/* Page rulers (horizontal + vertical) for the document viewport.
 *
 * Both rulers render flush against the doc paper — Google Docs style. The
 * horizontal one sits directly above the page (no gap), the vertical one
 * runs down the left edge of the page. Both show inch ticks (major every
 * 1in, minor every 1/8in) and margin handles at the page padding edges.
 *
 * Decorative for v1 (margin drags not wired yet).
 */

import type { CSSProperties } from "react";

const PX_PER_INCH = 96;

export interface NativeDocumentRulerProps {
  readonly pageWidth: number;
  readonly sidePadding: number;
}

export function NativeDocumentRuler({ pageWidth, sidePadding }: NativeDocumentRulerProps) {
  const inches = Math.max(1, Math.ceil(pageWidth / PX_PER_INCH));
  const marks: number[] = [];
  for (let i = 0; i <= inches; i++) marks.push(i);

  return (
    <div
      aria-hidden="true"
      style={{
        width: pageWidth,
        height: 20,
        marginInline: "auto",
        position: "relative",
        color: "var(--text-3)",
        fontSize: 10,
        fontFamily: "system-ui",
        userSelect: "none",
        background:
          `linear-gradient(to right, var(--surface-2) 0, var(--surface-2) ${sidePadding}px, var(--surface) ${sidePadding}px, var(--surface) calc(100% - ${sidePadding}px), var(--surface-2) calc(100% - ${sidePadding}px), var(--surface-2) 100%)`,
        borderInline: "1px solid var(--border)",
      }}
    >
      {marks.map((inch) => {
        const x = inch * PX_PER_INCH;
        if (x > pageWidth) return null;
        return (
          <span
            key={inch}
            style={{
              position: "absolute",
              left: x,
              top: 3,
              transform: "translateX(-50%)",
              pointerEvents: "none",
              lineHeight: 1,
            }}
          >
            {inch}
          </span>
        );
      })}
      {marks.flatMap((inch) =>
        [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875].map((frac) => {
          const x = (inch + frac) * PX_PER_INCH;
          if (x > pageWidth) return null;
          return (
            <span
              key={`${inch}-${frac}`}
              style={{
                position: "absolute",
                left: x,
                bottom: 0,
                width: 1,
                height: frac === 0.5 ? 4 : 2,
                background: "currentColor",
                opacity: 0.4,
              }}
            />
          );
        }),
      )}
      <div
        title="Left margin"
        style={{
          position: "absolute",
          left: sidePadding,
          top: -3,
          transform: "translateX(-50%)",
          width: 0,
          height: 0,
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderTop: "6px solid var(--text-2)",
        }}
      />
      <div
        title="Right margin"
        style={{
          position: "absolute",
          left: pageWidth - sidePadding,
          top: -3,
          transform: "translateX(-50%)",
          width: 0,
          height: 0,
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderTop: "6px solid var(--text-2)",
        }}
      />
    </div>
  );
}

export interface NativeDocumentVerticalRulerProps {
  /** Page height in CSS px. */
  readonly pageHeight: number;
  /** Top/bottom padding inside the paper. */
  readonly verticalPadding: number;
}

export function NativeDocumentVerticalRuler({
  pageHeight,
  verticalPadding,
}: NativeDocumentVerticalRulerProps) {
  const inches = Math.max(1, Math.ceil(pageHeight / PX_PER_INCH));
  const marks: number[] = [];
  for (let i = 0; i <= inches; i++) marks.push(i);

  return (
    <div
      aria-hidden="true"
      style={{
        width: 22,
        flexShrink: 0,
        height: pageHeight,
        position: "relative",
        color: "var(--text-3)",
        fontSize: 10,
        fontFamily: "system-ui",
        userSelect: "none",
        // Single visible background distinct from the page paper so the ruler
        // reads as its own column. Padding zones use the bg color, content
        // zone slightly lighter.
        background: "var(--bg)",
        borderRight: "1px solid var(--border)",
      }}
    >
      {marks.map((inch) => {
        const y = inch * PX_PER_INCH;
        if (y > pageHeight) return null;
        return (
          <span
            key={inch}
            style={{
              position: "absolute",
              top: y,
              left: "50%",
              transform: "translate(-50%, -50%)",
              pointerEvents: "none",
              lineHeight: 1,
            }}
          >
            {inch}
          </span>
        );
      })}
      {marks.flatMap((inch) =>
        [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875].map((frac) => {
          const y = (inch + frac) * PX_PER_INCH;
          if (y > pageHeight) return null;
          return (
            <span
              key={`${inch}-${frac}`}
              style={{
                position: "absolute",
                top: y,
                right: 0,
                width: frac === 0.5 ? 4 : 2,
                height: 1,
                background: "currentColor",
                opacity: 0.4,
              }}
            />
          );
        }),
      )}
      <div
        title="Top margin"
        style={{
          position: "absolute",
          top: verticalPadding,
          left: -3,
          transform: "translateY(-50%)",
          width: 0,
          height: 0,
          borderTop: "5px solid transparent",
          borderBottom: "5px solid transparent",
          borderLeft: "6px solid var(--text-2)",
        }}
      />
    </div>
  );
}
