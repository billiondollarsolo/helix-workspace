/**
 * Explicit mail-only secret namespace. Stored provider records may select one
 * of these references, but can never name arbitrary application credentials.
 */
export const OUTBOUND_MAIL_SECRET_REFERENCES = [
  "MAIL_SMTP_PASS",
  "SES_SMTP_PASS",
  "MAILGUN_API_KEY",
  "POSTMARK_SERVER_TOKEN",
] as const;

export const WEBHOOK_MAIL_SECRET_REFERENCES = ["MAIL_PROVIDER_WEBHOOK_SECRET"] as const;

const allowedMailSecretReferences = new Set<string>([
  ...OUTBOUND_MAIL_SECRET_REFERENCES,
  ...WEBHOOK_MAIL_SECRET_REFERENCES,
]);

export function isAllowedMailSecretReference(reference: string): boolean {
  return allowedMailSecretReferences.has(reference);
}
