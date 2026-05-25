import { z } from "zod";
import { slideBackgrounds, splitSlideRightKinds, type SlideContent } from "./types.js";

/**
 * Zod schemas for the six typed slide-layout content shapes, expressed as a
 * discriminated union on `layout`. This is the single source of truth for what
 * a valid {@link SlideContent} body looks like; both the tool input layer and
 * the store's persistence layer validate against it so malformed layout JSON
 * can never reach (or leave) the database.
 */

const slideStatSchema = z.object({
  value: z.string().min(1).max(64),
  label: z.string().min(1).max(160),
  note: z.string().max(280).default(""),
});

const slideShapeAnimationSchema = z.object({
  type: z.enum(["fade", "fly", "zoom"]),
  motionPath: z.enum(["up", "down", "left", "right"]).optional(),
  order: z.number().int().min(0).max(199).optional(),
  durationMs: z.number().int().min(120).max(5_000).optional(),
  easing: z.enum(["standard", "linear", "easeIn", "easeOut", "easeInOut"]).optional(),
});

const slideTransitionSchema = z.object({
  type: z.enum(["fade", "slide", "zoom"]),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  durationMs: z.number().int().min(120).max(3_000).optional(),
});

const slideShapeSchema = z
  .object({
    id: z.string().min(1).max(120),
    kind: z.enum(["text", "rectangle", "connector", "image", "media"]),
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
    width: z.number().min(1).max(100),
    height: z.number().min(1).max(100),
    text: z.string().max(1_000).optional(),
    tone: z.enum(["accent", "light", "dark"]).optional(),
    connectorDirection: z.enum(["up", "down"]).optional(),
    connectorArrow: z.enum(["none", "start", "end", "both"]).optional(),
    imageUrl: z.string().max(2_000).optional(),
    imageAlt: z.string().max(280).optional(),
    imageFit: z.enum(["contain", "cover"]).optional(),
    imageMask: z.enum(["rectangle", "rounded", "circle"]).optional(),
    mediaUrl: z.string().max(2_000).optional(),
    mediaType: z.enum(["video", "audio"]).optional(),
    mediaTitle: z.string().max(280).optional(),
    mediaPosterUrl: z.string().max(2_000).optional(),
    mediaCaptionUrl: z.string().max(2_000).optional(),
    mediaCaptionLabel: z.string().max(80).optional(),
    mediaStartSeconds: z.number().int().min(0).max(86_400).optional(),
    mediaEndSeconds: z.number().int().min(1).max(86_400).optional(),
    mediaAutoplay: z.boolean().optional(),
    mediaLoop: z.boolean().optional(),
    mediaMuted: z.boolean().optional(),
    animation: slideShapeAnimationSchema.optional(),
    exitAnimation: slideShapeAnimationSchema.optional(),
  })
  .superRefine((shape, ctx) => {
    if (
      shape.mediaEndSeconds !== undefined &&
      shape.mediaEndSeconds <= (shape.mediaStartSeconds ?? 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mediaEndSeconds must be greater than mediaStartSeconds",
        path: ["mediaEndSeconds"],
      });
    }
  });

const shapeLayerSchema = {
  shapes: z.array(slideShapeSchema).max(200).optional(),
  transition: slideTransitionSchema.optional(),
} as const;

const titleContentSchema = z.object({
  layout: z.literal("title"),
  title: z.string().min(1).max(280),
  eyebrow: z.string().max(160).optional(),
  subtitle: z.string().max(480).optional(),
  bg: z.enum(slideBackgrounds).optional(),
  ...shapeLayerSchema,
});

const agendaContentSchema = z.object({
  layout: z.literal("agenda"),
  title: z.string().min(1).max(280),
  items: z.array(z.string().min(1).max(280)).max(24),
  ...shapeLayerSchema,
});

const statsContentSchema = z.object({
  layout: z.literal("stats"),
  title: z.string().min(1).max(280),
  subtitle: z.string().max(480).optional(),
  stats: z.array(slideStatSchema).max(6),
  ...shapeLayerSchema,
});

const splitContentSchema = z.object({
  layout: z.literal("split"),
  title: z.string().min(1).max(280),
  left: z.string().max(2_000),
  rightKind: z.enum(splitSlideRightKinds),
  rightContent: z.union([z.string().max(2_000), z.array(z.string().min(1).max(280)).max(24)]),
  quoteWho: z.string().max(160).optional(),
  ...shapeLayerSchema,
});

const bulletsContentSchema = z.object({
  layout: z.literal("bullets"),
  title: z.string().min(1).max(280),
  items: z.array(z.string().min(1).max(280)).max(24),
  ...shapeLayerSchema,
});

const imageContentSchema = z.object({
  layout: z.literal("image"),
  title: z.string().min(1).max(280),
  note: z.string().max(480).default(""),
  ...shapeLayerSchema,
});

/** Discriminated union over the six layout content shapes. */
export const slideContentSchema = z.discriminatedUnion("layout", [
  titleContentSchema,
  agendaContentSchema,
  statsContentSchema,
  splitContentSchema,
  bulletsContentSchema,
  imageContentSchema,
]);

export type SlideContentInput = z.input<typeof slideContentSchema>;

/**
 * Parse and normalize an untyped value into a valid {@link SlideContent}.
 * Throws a {@link z.ZodError} when the value is not a valid layout body.
 */
export function parseSlideContent(value: unknown): SlideContent {
  return slideContentSchema.parse(value) as SlideContent;
}
