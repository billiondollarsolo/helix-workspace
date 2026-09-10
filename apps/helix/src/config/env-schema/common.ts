import { z } from "zod";
export const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v))
  .pipe(z.string().url().optional());
export const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v));
export const coercePositiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);
export const coerceNonNegInt = (fallback: number) =>
  z.coerce.number().int().nonnegative().default(fallback);
export const optionalPositiveInt = z.preprocess(
  (value) => (value === undefined || value === "" ? undefined : value),
  z.coerce.number().int().positive().optional(),
);
