import type { JsonObject } from "@helix/sdk-types";

export const slidesPluginId = "com.helix.core.slides";

/** The six slide layout discriminants. Mirrors the Slides UI. */
export const slideLayouts = ["title", "agenda", "stats", "split", "bullets", "image"] as const;
export type SlideLayout = (typeof slideLayouts)[number];

/** Background treatment for a `title` slide. */
export const slideBackgrounds = ["accent", "neutral"] as const;
export type SlideBackground = (typeof slideBackgrounds)[number];

/** The right-hand panel kind on a `split` slide. */
export const splitSlideRightKinds = ["quote", "list"] as const;
export type SplitSlideRightKind = (typeof splitSlideRightKinds)[number];

/** A single statistic on a `stats` slide. */
export interface SlideStat {
  readonly value: string;
  readonly label: string;
  readonly note: string;
}

/** Full-bleed title slide body. */
export interface TitleSlideContent {
  readonly layout: "title";
  readonly title: string;
  readonly eyebrow?: string;
  readonly subtitle?: string;
  readonly bg?: SlideBackground;
}

/** Numbered agenda slide body. */
export interface AgendaSlideContent {
  readonly layout: "agenda";
  readonly title: string;
  readonly items: readonly string[];
}

/** Three-column statistics slide body. */
export interface StatsSlideContent {
  readonly layout: "stats";
  readonly title: string;
  readonly subtitle?: string;
  readonly stats: readonly SlideStat[];
}

/** Two-column slide: prose left, quote or list right. */
export interface SplitSlideContent {
  readonly layout: "split";
  readonly title: string;
  readonly left: string;
  readonly rightKind: SplitSlideRightKind;
  readonly rightContent: string | readonly string[];
  readonly quoteWho?: string;
}

/** Bulleted content slide body. */
export interface BulletsSlideContent {
  readonly layout: "bullets";
  readonly title: string;
  readonly items: readonly string[];
}

/** Image-placeholder slide body. */
export interface ImageSlideContent {
  readonly layout: "image";
  readonly title: string;
  readonly note: string;
}

/**
 * The typed per-layout slide body, discriminated on `layout`. Persisted as the
 * `slides.content` JSONB column.
 */
export type SlideContent =
  | TitleSlideContent
  | AgendaSlideContent
  | StatsSlideContent
  | SplitSlideContent
  | BulletsSlideContent
  | ImageSlideContent;

/** A presentation deck. */
export interface SlideDeckRecord {
  readonly id: string;
  readonly orgId: string;
  readonly title: string;
  readonly ownerActorId: string | null;
  readonly createdByActorId: string | null;
  readonly metadata: JsonObject;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A deck record enriched with its current slide count. */
export interface SlideDeckSummaryRecord extends SlideDeckRecord {
  readonly slideCount: number;
}

/** A single ordered slide within a deck. */
export interface SlideRecord {
  readonly id: string;
  readonly orgId: string;
  readonly deckId: string;
  readonly position: number;
  readonly layout: SlideLayout;
  readonly content: SlideContent;
  readonly speakerNotes: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
