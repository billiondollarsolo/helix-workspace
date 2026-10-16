import { z } from "zod";
import { canonicalTimeZone } from "./calendar-time.js";

export const accountEmailFactorStatusSchema = z.object({
  outboundReady: z.boolean(),
  email: z.string().email().nullable(),
  verified: z.boolean(),
  enabled: z.boolean(),
  totpEnabled: z.boolean(),
  pendingEmail: z.string().email().nullable(),
});
export type AccountEmailFactorStatus = z.infer<typeof accountEmailFactorStatusSchema>;
export const accountExternalEmailVerificationSchema = z
  .object({
    email: z.string().trim().toLowerCase().max(320).email(),
    password: z.string().min(1).max(128),
  })
  .strict();
export const accountEmailCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/u) }).strict();
export const accountEmailFactorToggleSchema = z
  .object({
    enabled: z.boolean(),
    password: z.string().min(1).max(128),
  })
  .strict();

const timeOfDaySchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, "Use 24-hour HH:MM.");
function knownTimeZone(zone: string): string | null {
  try {
    return canonicalTimeZone(zone);
  } catch {
    return null;
  }
}
const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((zone) => knownTimeZone(zone) !== null, "Use an IANA time zone such as Europe/Paris.")
  .transform((zone) => knownTimeZone(zone) ?? zone);

/** Working hours per weekday (0 = Sunday); a missing day is not a working day. */
export const accountWorkingHoursSchema = z
  .object({
    enabled: z.boolean(),
    days: z
      .array(
        z
          .object({
            day: z.number().int().min(0).max(6),
            start: timeOfDaySchema,
            end: timeOfDaySchema,
          })
          .refine((range) => range.start < range.end, "Working hours must end after they start."),
      )
      .max(7)
      .refine(
        (days) => new Set(days.map(({ day }) => day)).size === days.length,
        "List each weekday at most once.",
      ),
  })
  .strict();
export type AccountWorkingHours = z.infer<typeof accountWorkingHoursSchema>;

export const ACCOUNT_DATE_FORMATS = ["mdy", "dmy", "ymd"] as const;
export const ACCOUNT_TIME_FORMATS = ["12h", "24h"] as const;
export const MAIL_READING_PANES = ["none", "right", "below"] as const;
export const MAIL_DENSITIES = ["default", "comfortable", "compact"] as const;

/**
 * Personal preferences. `null` means "not chosen": the client follows the
 * browser locale (language, formats, week start) or zone.
 */
export const accountPreferencesSchema = z.object({
  language: z.string().nullable(),
  timeZone: z.string().nullable(),
  dateFormat: z.enum(ACCOUNT_DATE_FORMATS).nullable(),
  timeFormat: z.enum(ACCOUNT_TIME_FORMATS).nullable(),
  /** 0 = Sunday … 6 = Saturday. */
  weekStart: z.number().int().min(0).max(6).nullable(),
  workingHours: accountWorkingHoursSchema.nullable(),
  mail: z.object({
    readingPane: z.enum(MAIL_READING_PANES),
    density: z.enum(MAIL_DENSITIES),
    conversationView: z.boolean(),
  }),
  updatedAt: z.string().nullable(),
});
export type AccountPreferences = z.infer<typeof accountPreferencesSchema>;

export const accountPreferencesGetInputSchema = z.object({}).strict();

/** Partial update: omitted fields keep their saved value; `null` clears one. */
export const accountPreferencesSetInputSchema = z
  .object({
    language: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/u, "Use a language tag such as en or pt-BR.")
      .nullable()
      .optional(),
    timeZone: timeZoneSchema.nullable().optional(),
    /**
     * The browser's zone. Saved only while no time zone is set, so the first
     * visit picks up the device zone without overriding a later choice.
     */
    detectedTimeZone: timeZoneSchema.optional(),
    dateFormat: z.enum(ACCOUNT_DATE_FORMATS).nullable().optional(),
    timeFormat: z.enum(ACCOUNT_TIME_FORMATS).nullable().optional(),
    weekStart: z.number().int().min(0).max(6).nullable().optional(),
    workingHours: accountWorkingHoursSchema.nullable().optional(),
    mail: z
      .object({
        readingPane: z.enum(MAIL_READING_PANES).optional(),
        density: z.enum(MAIL_DENSITIES).optional(),
        conversationView: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AccountPreferencesSetInput = z.infer<typeof accountPreferencesSetInputSchema>;

/** One signed-in browser or device; tokens never leave the server. */
export const accountSessionSchema = z.object({
  id: z.string(),
  current: z.boolean(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  expiresAt: z.string(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  browser: z.string(),
  os: z.string(),
  deviceType: z.enum(["desktop", "mobile", "tablet", "unknown"]),
});
export type AccountSession = z.infer<typeof accountSessionSchema>;
export const accountSessionsListResultSchema = z.object({
  sessions: z.array(accountSessionSchema),
});
export const accountSessionRevokeParamsSchema = z.object({ sessionId: z.string().min(1).max(256) });

export const accountPasswordChangeInputSchema = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(8).max(128),
    revokeOtherSessions: z.boolean().default(false),
  })
  .strict();
export type AccountPasswordChangeInput = z.input<typeof accountPasswordChangeInputSchema>;
