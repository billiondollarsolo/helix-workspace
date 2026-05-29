/* Slide thumbnail rail — pure component extracted from the native
   presentation editor. Renders the ordered list of slide thumbnails with
   per-slide actions (reorder, duplicate, delete) and an open-comments
   badge. The editor wires this into <EditorWorkspace leftRail={…}>. */

import type { CSSProperties, ReactNode } from "react";
import { Icons } from "@/components/icons";
import type { SlidesApiSlide } from "./api";
import type { SlideContent } from "./seed";

export interface SlideThumbnailRailProps {
  readonly slides: readonly SlidesApiSlide[];
  readonly activeSlideId: string | null;
  readonly openCommentCounts: Map<string, number>;
  readonly slideTitleOf: (content: SlideContent) => string;
  readonly reorderPending: boolean;
  readonly createPending: boolean;
  readonly deletePending: boolean;
  readonly onSelectSlide: (slideId: string) => void;
  readonly onMoveSlide: (slideId: string, delta: -1 | 1) => void;
  readonly onDuplicateSlide: (slide: SlidesApiSlide) => void;
  readonly onRemoveSlide: (slideId: string) => void;
  /** Optional extra footer content (deck-level tables etc). */
  readonly footer?: ReactNode;
}

export function SlideThumbnailRail({
  slides,
  activeSlideId,
  openCommentCounts,
  slideTitleOf,
  reorderPending,
  createPending,
  deletePending,
  onSelectSlide,
  onMoveSlide,
  onDuplicateSlide,
  onRemoveSlide,
  footer,
}: SlideThumbnailRailProps): ReactNode {
  return (
    <aside style={THUMB_RAIL_STYLE} aria-label="Slides">
      {slides.length === 0 ? (
        <p style={EMPTY_STYLE}>No slides</p>
      ) : (
        slides.map((slide, index) => {
          const openCommentCount = openCommentCounts.get(slide.id) ?? 0;
          const title = slideTitleOf(slide.content);
          return (
            <div
              key={slide.id}
              style={{
                ...THUMB_ROW_STYLE,
                borderColor: activeSlideId === slide.id ? "var(--accent)" : "var(--border)",
              }}
            >
              <button
                type="button"
                aria-pressed={activeSlideId === slide.id}
                onClick={() => onSelectSlide(slide.id)}
                style={THUMB_SELECT_STYLE}
              >
                <span style={THUMB_INDEX_STYLE}>{index + 1}</span>
                <span className="truncate" style={THUMB_TITLE_STYLE}>
                  {title}
                </span>
                {openCommentCount > 0 ? (
                  <span
                    style={THUMB_COMMENT_BADGE_STYLE}
                    aria-label={`${String(openCommentCount)} open comments for ${title}`}
                  >
                    {openCommentCount}
                  </span>
                ) : null}
              </button>
              <span style={THUMB_ACTIONS_STYLE}>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Move ${title} up`}
                  disabled={index === 0 || reorderPending}
                  onClick={() => onMoveSlide(slide.id, -1)}
                  title="Move up"
                >
                  <Icons.ChevronDown style={{ transform: "rotate(180deg)" }} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Move ${title} down`}
                  disabled={index === slides.length - 1 || reorderPending}
                  onClick={() => onMoveSlide(slide.id, 1)}
                  title="Move down"
                >
                  <Icons.ChevronDown />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Duplicate ${title}`}
                  disabled={createPending}
                  onClick={() => onDuplicateSlide(slide)}
                  title="Duplicate slide"
                >
                  <Icons.Copy />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Delete ${title}`}
                  disabled={deletePending}
                  onClick={() => onRemoveSlide(slide.id)}
                  title="Delete slide"
                >
                  <Icons.Trash />
                </button>
              </span>
            </div>
          );
        })
      )}
      {footer}
    </aside>
  );
}

const THUMB_RAIL_STYLE = {
  display: "grid",
  alignContent: "start",
  gap: 8,
  padding: 12,
  background: "var(--surface-2)",
  overflowY: "auto",
} satisfies CSSProperties;

const THUMB_ROW_STYLE = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 6,
  alignItems: "center",
  padding: "6px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface)",
} satisfies CSSProperties;

const THUMB_SELECT_STYLE = {
  display: "grid",
  gridTemplateColumns: "28px minmax(0, 1fr) auto",
  gap: 8,
  alignItems: "center",
  minWidth: 0,
  height: 30,
  padding: "0 4px",
  border: "none",
  background: "transparent",
  color: "var(--text)",
  textAlign: "left",
  font: "inherit",
  cursor: "pointer",
} satisfies CSSProperties;

const THUMB_ACTIONS_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 2,
} satisfies CSSProperties;

const THUMB_INDEX_STYLE = {
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const THUMB_TITLE_STYLE = { minWidth: 0, fontSize: "var(--text-body-sm)" } satisfies CSSProperties;

const THUMB_COMMENT_BADGE_STYLE = {
  display: "inline-grid",
  placeItems: "center",
  minWidth: 20,
  height: 20,
  padding: "0 6px",
  borderRadius: 999,
  background: "var(--accent)",
  color: "#fff",
  fontSize: "var(--text-caption)",
  fontWeight: 800,
} satisfies CSSProperties;

const EMPTY_STYLE = {
  margin: 0,
  color: "var(--text-3)",
  fontSize: "var(--text-body-sm)",
} satisfies CSSProperties;
