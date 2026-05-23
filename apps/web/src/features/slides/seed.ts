/* Helix Slides — shared types, conversion helpers, and layout options.
 *
 * The seed `DECKS` / `SLIDES` / `SPEAKER_NOTES` arrays that lived here have
 * been removed. The list, editor, and speaker-notes panel render only live
 * data from the Slides tools (`slides.deck.*`, `slides.slide.*`). What
 * remains here are the type unions per layout, conversions between Slide
 * and SlideContent shapes, and the static `SLIDE_LAYOUT_OPTIONS` list that
 * drives the editor's layout `<select>`. */

/** A deck row in the Slides list view. */
export interface SlideDeck {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly modified: string;
  readonly slides: number;
  readonly shared: number;
  /** `"backend"` rows are persisted decks; `"seed"` rows are the offline fallback. */
  readonly source?: "backend" | "seed";
}

/** Background treatment for a `title` slide. */
export type SlideBackground = "accent" | "neutral";

/** The six slide layout discriminants. */
export type SlideLayout =
  | "title"
  | "agenda"
  | "stats"
  | "split"
  | "bullets"
  | "image";

/** A single statistic on a `stats` slide. */
export interface SlideStat {
  readonly value: string;
  readonly label: string;
  readonly note: string;
}

/** A slide id — a numeric handoff-seed id or a backend UUID string. */
export type SlideId = number | string;

/** Full-bleed title slide. */
export interface TitleSlide {
  readonly id: SlideId;
  readonly layout: "title";
  readonly title: string;
  readonly eyebrow?: string;
  readonly subtitle?: string;
  readonly bg?: SlideBackground;
}

/** Numbered agenda slide. */
export interface AgendaSlide {
  readonly id: SlideId;
  readonly layout: "agenda";
  readonly title: string;
  readonly items: readonly string[];
}

/** Three-column statistics slide. */
export interface StatsSlide {
  readonly id: SlideId;
  readonly layout: "stats";
  readonly title: string;
  readonly subtitle?: string;
  readonly stats: readonly SlideStat[];
}

/** Two-column slide: prose left, quote or list right. */
export interface SplitSlide {
  readonly id: SlideId;
  readonly layout: "split";
  readonly title: string;
  readonly left: string;
  readonly rightKind: "quote" | "list";
  readonly rightContent: string | readonly string[];
  readonly quoteWho?: string;
}

/** Bulleted content slide. */
export interface BulletsSlide {
  readonly id: SlideId;
  readonly layout: "bullets";
  readonly title: string;
  readonly items: readonly string[];
}

/** Image-placeholder slide. */
export interface ImageSlide {
  readonly id: SlideId;
  readonly layout: "image";
  readonly title: string;
  readonly note: string;
}

/** A slide in any of the six layouts. */
export type Slide =
  | TitleSlide
  | AgendaSlide
  | StatsSlide
  | SplitSlide
  | BulletsSlide
  | ImageSlide;

/* -------------------------------------------------------------------------- */
/* Typed slide content (the backend `slides.content` JSON payload)            */
/* -------------------------------------------------------------------------- */

/** Title-slide content body (no `id` — that lives on the slide record). */
export type TitleSlideContent = Omit<TitleSlide, "id">;
/** Agenda-slide content body. */
export type AgendaSlideContent = Omit<AgendaSlide, "id">;
/** Stats-slide content body. */
export type StatsSlideContent = Omit<StatsSlide, "id">;
/** Split-slide content body. */
export type SplitSlideContent = Omit<SplitSlide, "id">;
/** Bullets-slide content body. */
export type BulletsSlideContent = Omit<BulletsSlide, "id">;
/** Image-slide content body. The backend requires a (possibly empty) `note`. */
export type ImageSlideContent = Omit<ImageSlide, "id">;

/**
 * The typed per-layout slide body, discriminated on `layout`. Mirrors the
 * backend `SlideContent` union persisted as the `slides.content` JSON column.
 */
export type SlideContent =
  | TitleSlideContent
  | AgendaSlideContent
  | StatsSlideContent
  | SplitSlideContent
  | BulletsSlideContent
  | ImageSlideContent;

/** Strip the local `id` to produce a backend content payload for a slide. */
export function slideToContent(slide: Slide): SlideContent {
  switch (slide.layout) {
    case "title":
      return {
        layout: "title",
        title: slide.title,
        ...(slide.eyebrow === undefined ? {} : { eyebrow: slide.eyebrow }),
        ...(slide.subtitle === undefined ? {} : { subtitle: slide.subtitle }),
        ...(slide.bg === undefined ? {} : { bg: slide.bg }),
      };
    case "agenda":
      return { layout: "agenda", title: slide.title, items: slide.items };
    case "stats":
      return {
        layout: "stats",
        title: slide.title,
        ...(slide.subtitle === undefined ? {} : { subtitle: slide.subtitle }),
        stats: slide.stats,
      };
    case "split":
      return {
        layout: "split",
        title: slide.title,
        left: slide.left,
        rightKind: slide.rightKind,
        rightContent: slide.rightContent,
        ...(slide.quoteWho === undefined ? {} : { quoteWho: slide.quoteWho }),
      };
    case "bullets":
      return { layout: "bullets", title: slide.title, items: slide.items };
    case "image":
      return { layout: "image", title: slide.title, note: slide.note };
  }
}

/** A blank typed content body for a freshly-created slide of `layout`. */
export function emptySlideContent(layout: SlideLayout): SlideContent {
  switch (layout) {
    case "title":
      return { layout: "title", title: "Untitled slide" };
    case "agenda":
      return { layout: "agenda", title: "Agenda", items: ["First topic"] };
    case "stats":
      return {
        layout: "stats",
        title: "Key numbers",
        stats: [{ value: "0", label: "Metric", note: "" }],
      };
    case "split":
      return {
        layout: "split",
        title: "Two-column slide",
        left: "Left column copy.",
        rightKind: "list",
        rightContent: ["First point"],
      };
    case "bullets":
      return { layout: "bullets", title: "Key points", items: ["First point"] };
    case "image":
      return { layout: "image", title: "Image slide", note: "Describe the image" };
  }
}

/**
 * Re-attach an `id` to a typed content body to produce a renderable `Slide`.
 * The inverse of {@link slideToContent}.
 */
export function contentToSlide(id: SlideId, content: SlideContent): Slide {
  return { ...content, id };
}

/** Layout options for the editor's layout `<select>`. */
export const SLIDE_LAYOUT_OPTIONS: ReadonlyArray<{
  readonly value: SlideLayout;
  readonly label: string;
}> = [
  { value: "title", label: "Title" },
  { value: "agenda", label: "Agenda" },
  { value: "stats", label: "Stats" },
  { value: "split", label: "Split" },
  { value: "bullets", label: "Bullets" },
  { value: "image", label: "Image" },
];
