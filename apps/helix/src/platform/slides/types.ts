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

/** Freeform slide object kind persisted in the slide content JSON. */
export type SlideShapeKind = "text" | "rectangle" | "connector" | "image" | "media";

/** Visual treatment for first-pass freeform shapes. */
export type SlideShapeTone = "accent" | "light" | "dark";

/** Text face persisted for freeform slide text. */
export type SlideShapeFontFamily = "inter" | "serif" | "mono" | "system";

/** Paragraph alignment persisted for freeform slide text. */
export type SlideShapeTextAlign = "left" | "center" | "right" | "justify";

/** Connector line direction inside the shape's percentage bounding box. */
export type SlideConnectorDirection = "up" | "down";

/** Connector arrowhead treatment. */
export type SlideConnectorArrow = "none" | "start" | "end" | "both";

/** Embedded media player type for freeform media shapes. */
export type SlideMediaType = "video" | "audio";

/** Image placement inside a freeform image shape's percentage box. */
export type SlideImageFit = "contain" | "cover";

/** Image mask applied inside a freeform image shape's percentage box. */
export type SlideImageMask = "rectangle" | "rounded" | "circle";

/** First-pass entrance animation for freeform shapes in present mode. */
export type SlideShapeAnimationType = "fade" | "fly" | "zoom";

/** Direction for fly-in motion path animations. */
export type SlideShapeMotionPath = "up" | "down" | "left" | "right";

/** Timing curve for entrance animations. */
export type SlideShapeAnimationEasing = "standard" | "linear" | "easeIn" | "easeOut" | "easeInOut";

export interface SlideShapeAnimation {
  readonly type: SlideShapeAnimationType;
  readonly motionPath?: SlideShapeMotionPath;
  readonly order?: number;
  readonly durationMs?: number;
  readonly easing?: SlideShapeAnimationEasing;
}

/** Slide-level transition applied when advancing through presentation mode. */
export type SlideTransitionType = "fade" | "slide" | "zoom";

/** Direction for slide-level push/slide transitions. */
export type SlideTransitionDirection = "left" | "right" | "up" | "down";

export interface SlideTransition {
  readonly type: SlideTransitionType;
  readonly direction?: SlideTransitionDirection;
  readonly durationMs?: number;
}

/** A percentage-positioned freeform object on top of a typed slide layout. */
export interface SlideShape {
  readonly id: string;
  readonly kind: SlideShapeKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text?: string;
  readonly linkUrl?: string;
  readonly tone?: SlideShapeTone;
  readonly fontFamily?: SlideShapeFontFamily;
  readonly fontSize?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  readonly textAlign?: SlideShapeTextAlign;
  readonly textColor?: string;
  readonly highlightColor?: string;
  readonly connectorDirection?: SlideConnectorDirection;
  readonly connectorArrow?: SlideConnectorArrow;
  readonly imageUrl?: string;
  readonly imageAlt?: string;
  readonly imageFit?: SlideImageFit;
  readonly imageMask?: SlideImageMask;
  readonly mediaUrl?: string;
  readonly mediaType?: SlideMediaType;
  readonly mediaTitle?: string;
  readonly mediaPosterUrl?: string;
  readonly mediaCaptionUrl?: string;
  readonly mediaCaptionLabel?: string;
  readonly mediaStartSeconds?: number;
  readonly mediaEndSeconds?: number;
  readonly mediaAutoplay?: boolean;
  readonly mediaLoop?: boolean;
  readonly mediaMuted?: boolean;
  readonly animation?: SlideShapeAnimation;
  readonly exitAnimation?: SlideShapeAnimation;
}

export interface SlideShapeLayer {
  readonly shapes?: readonly SlideShape[];
  readonly transition?: SlideTransition;
}

/** Full-bleed title slide body. */
export interface TitleSlideContent extends SlideShapeLayer {
  readonly layout: "title";
  readonly title: string;
  readonly eyebrow?: string;
  readonly subtitle?: string;
  readonly bg?: SlideBackground;
}

/** Numbered agenda slide body. */
export interface AgendaSlideContent extends SlideShapeLayer {
  readonly layout: "agenda";
  readonly title: string;
  readonly items: readonly string[];
}

/** Three-column statistics slide body. */
export interface StatsSlideContent extends SlideShapeLayer {
  readonly layout: "stats";
  readonly title: string;
  readonly subtitle?: string;
  readonly stats: readonly SlideStat[];
}

/** Two-column slide: prose left, quote or list right. */
export interface SplitSlideContent extends SlideShapeLayer {
  readonly layout: "split";
  readonly title: string;
  readonly left: string;
  readonly rightKind: SplitSlideRightKind;
  readonly rightContent: string | readonly string[];
  readonly quoteWho?: string;
}

/** Bulleted content slide body. */
export interface BulletsSlideContent extends SlideShapeLayer {
  readonly layout: "bullets";
  readonly title: string;
  readonly items: readonly string[];
}

/** Image-placeholder slide body. */
export interface ImageSlideContent extends SlideShapeLayer {
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

/** A single ordered slide within a deck.
 *
 * `revision` is a per-slide compare-and-swap counter. Clients pass the
 * revision they observed locally in `update-slide` / `delete-slide` sync
 * operations; if the server's row has advanced, the operation is rejected
 * with `slide-conflict` so the client can re-fetch before retrying. This is
 * the interim safety net while per-shape OT is built (see
 * `docs/reviews/follow-up.md`). */
export interface SlideRecord {
  readonly id: string;
  readonly orgId: string;
  readonly deckId: string;
  readonly position: number;
  readonly layout: SlideLayout;
  readonly content: SlideContent;
  readonly speakerNotes: string;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
