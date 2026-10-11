import { z } from "zod";
import { sanitizeMailHtml } from "./html-rendering.js";
import type { MailUserSettings } from "./types.js";

/**
 * Partial update for a user's mail settings. An omitted field keeps its saved
 * value; `signatureHtml: null` explicitly clears the HTML signature.
 */
export interface MailUserSettingsPatch {
  readonly signatureText?: string | undefined;
  readonly signatureHtml?: string | null | undefined;
  readonly includeSignatureOnReplies?: boolean | undefined;
  readonly blockedSenders?: readonly string[] | undefined;
}

export type SetMailUserSettingsInput = MailUserSettingsPatch & {
  readonly orgId: string;
  readonly actorId: string;
};

const MAIL_USER_SETTINGS_KEYS = [
  "signatureText",
  "signatureHtml",
  "includeSignatureOnReplies",
  "blockedSenders",
] as const;

export const mailUserSettingsSetSchema = z
  .object({
    signatureText: z.string().max(40_000),
    signatureHtml: z.string().max(100_000).nullable(),
    includeSignatureOnReplies: z.boolean(),
    blockedSenders: z.array(z.string().email()).max(1_000),
  })
  .partial()
  .strict()
  .refine((input) => MAIL_USER_SETTINGS_KEYS.some((key) => input[key] !== undefined), {
    message: `Provide at least one of ${MAIL_USER_SETTINGS_KEYS.join(", ")}. Omitted fields keep their saved values.`,
  });

/** Normalizes only the submitted fields, so omitted fields stay untouched. */
export function mailUserSettingsPatch(
  input: z.output<typeof mailUserSettingsSetSchema>,
): MailUserSettingsPatch {
  return {
    ...(input.signatureText === undefined ? {} : { signatureText: input.signatureText.trim() }),
    ...(input.signatureHtml === undefined
      ? {}
      : {
          signatureHtml:
            input.signatureHtml === null ? null : sanitizeMailHtml(input.signatureHtml).html,
        }),
    ...(input.includeSignatureOnReplies === undefined
      ? {}
      : { includeSignatureOnReplies: input.includeSignatureOnReplies }),
    ...(input.blockedSenders === undefined
      ? {}
      : {
          blockedSenders: [
            ...new Set(input.blockedSenders.map((address) => address.toLowerCase())),
          ],
        }),
  };
}

/** In-memory mirror of the store's merge, for test doubles. */
export function applyMailUserSettingsPatch(
  current: MailUserSettings,
  patch: MailUserSettingsPatch,
  updatedAt: Date,
): MailUserSettings {
  return {
    signatureText: patch.signatureText ?? current.signatureText,
    signatureHtml: patch.signatureHtml === undefined ? current.signatureHtml : patch.signatureHtml,
    includeSignatureOnReplies: patch.includeSignatureOnReplies ?? current.includeSignatureOnReplies,
    blockedSenders: patch.blockedSenders ?? current.blockedSenders,
    updatedAt,
  };
}
