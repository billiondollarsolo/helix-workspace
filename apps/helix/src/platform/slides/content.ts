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

const titleContentSchema = z.object({
  layout: z.literal("title"),
  title: z.string().min(1).max(280),
  eyebrow: z.string().max(160).optional(),
  subtitle: z.string().max(480).optional(),
  bg: z.enum(slideBackgrounds).optional(),
});

const agendaContentSchema = z.object({
  layout: z.literal("agenda"),
  title: z.string().min(1).max(280),
  items: z.array(z.string().min(1).max(280)).max(24),
});

const statsContentSchema = z.object({
  layout: z.literal("stats"),
  title: z.string().min(1).max(280),
  subtitle: z.string().max(480).optional(),
  stats: z.array(slideStatSchema).max(6),
});

const splitContentSchema = z.object({
  layout: z.literal("split"),
  title: z.string().min(1).max(280),
  left: z.string().max(2_000),
  rightKind: z.enum(splitSlideRightKinds),
  rightContent: z.union([z.string().max(2_000), z.array(z.string().min(1).max(280)).max(24)]),
  quoteWho: z.string().max(160).optional(),
});

const bulletsContentSchema = z.object({
  layout: z.literal("bullets"),
  title: z.string().min(1).max(280),
  items: z.array(z.string().min(1).max(280)).max(24),
});

const imageContentSchema = z.object({
  layout: z.literal("image"),
  title: z.string().min(1).max(280),
  note: z.string().max(480).default(""),
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
