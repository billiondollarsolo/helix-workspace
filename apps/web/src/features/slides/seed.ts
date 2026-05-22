/* Helix Slides — seed data.
   Ported verbatim from the design handoff (app-slides.jsx → DECKS / SLIDES).
   There is no Slides backend; this typed seed module stands in for the
   `GET /api/decks` + `…/slides` endpoints called out in the handoff. */

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

/** Seeded decks for the list view (mock for `GET /api/decks`). */
export const DECKS: readonly SlideDeck[] = [
  {
    id: "s1",
    title: "Q3 All-Hands narrative",
    owner: "Alex Park",
    modified: "2 hours ago",
    slides: 18,
    shared: 24,
  },
  {
    id: "s2",
    title: "Helix Workspace launch",
    owner: "Owen Hart",
    modified: "Yesterday",
    slides: 32,
    shared: 8,
  },
  {
    id: "s3",
    title: "Board update — May 2026",
    owner: "Mira Okafor",
    modified: "2 days ago",
    slides: 14,
    shared: 6,
  },
  {
    id: "s4",
    title: "Engineering onsite",
    owner: "Jonas Reichert",
    modified: "Last week",
    slides: 22,
    shared: 4,
  },
  {
    id: "s5",
    title: "Design principles",
    owner: "Priya Anand",
    modified: "Last week",
    slides: 28,
    shared: 12,
  },
];

/** Seeded slides for the editor (mock for `GET /api/decks/:id/slides`).
   Layout definitions kept verbatim from the handoff. */
export const SLIDES: readonly Slide[] = [
  {
    id: 1,
    layout: "title",
    eyebrow: "All-Hands · May 2026",
    title: "Building the workspace people actually want",
    subtitle: "Q3 — what we shipped, what's next, and where we need help",
    bg: "accent",
  },
  {
    id: 2,
    layout: "agenda",
    title: "Agenda",
    items: [
      "Where we are",
      "Q3 priorities",
      "Customer signal",
      "Hiring",
      "What we need from you",
    ],
  },
  {
    id: 3,
    layout: "stats",
    title: "Where we are",
    subtitle: "Three numbers from the last 90 days",
    stats: [
      {
        value: "+38%",
        label: "DAU vs last quarter",
        note: "Driven by Mail + Docs adoption",
      },
      { value: "94%", label: "Customers on MFA", note: "Target was 90" },
      {
        value: "$1.4M",
        label: "New ARR in pipeline",
        note: "Q3 close to date",
      },
    ],
  },
  {
    id: 4,
    layout: "split",
    title: "What customers are telling us",
    left:
      "The fastest growing request — and the one we keep hearing in win/loss interviews — is unified search across Mail, Docs, and Drive. Customers want one place to find everything.",
    rightKind: "quote",
    rightContent:
      "\"We spend more time looking for the deck than writing it. If Helix can fix that, we don't need anything else.\"",
    quoteWho: "VP Operations, Atlas Holdings",
  },
  {
    id: 5,
    layout: "bullets",
    title: "Q3 priorities",
    items: [
      "Unified search across all surfaces (P0)",
      "Helix AI in the side panel of every app (P0)",
      "Atlas Holdings migration to v2 platform (P1)",
      "New region rollout — Frankfurt (P1)",
      "Cost per active user down 22% (P2)",
    ],
  },
  {
    id: 6,
    layout: "image",
    title: "Helix AI side panel",
    note: "Demo screenshot — Mail with Helix AI panel open, summarizing inbox",
  },
  {
    id: 7,
    layout: "split",
    title: "Hiring",
    left:
      "Five open roles across Platform and Product Engineering. Senior engineers, an EM, an SRE, and a platform PM. Onsite loops start next week.",
    rightKind: "list",
    rightContent: [
      "Senior Engineer × 2",
      "Engineering Manager",
      "Site Reliability Engineer",
      "Platform PM",
    ],
  },
  {
    id: 8,
    layout: "title",
    eyebrow: "Closing",
    title: "Thank you",
    subtitle: "Questions to Mira, Jonas, or me — async or in #all-helix",
    bg: "neutral",
  },
];

/** Speaker-notes seed, keyed by slide id. Mirrors the handoff default note. */
export const SPEAKER_NOTES: Readonly<Record<number, string>> = {
  1: "Welcome everyone. Quick recap of where we are, then I'll hand to Jonas for Q3 priorities and Sasha for hiring.",
};

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
