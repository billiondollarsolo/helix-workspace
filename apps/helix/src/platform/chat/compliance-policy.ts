/** Platform defaults when an organization has not set a Chat retention policy.
 *  Matches `chat_retention_policies` column defaults and the retention sweep
 *  fallback (`2555` days ≈ 7 years). */
export const CHAT_PLATFORM_DEFAULT_RETENTION_DAYS = 2555;
export const CHAT_PLATFORM_DEFAULT_EDIT_WINDOW_SECONDS = 86_400;
export const CHAT_PLATFORM_DEFAULT_DELETE_WINDOW_SECONDS = 86_400;

export function chatMutationAllowed(input: {
  readonly legalHold: boolean;
  readonly windowSeconds: number;
  readonly sentAt: Date;
  readonly now: Date;
}): boolean {
  return (
    !input.legalHold && input.now.getTime() - input.sentAt.getTime() <= input.windowSeconds * 1000
  );
}

export function chatRetentionEligible(input: {
  readonly legalHold: boolean;
  readonly retentionDays: number;
  readonly sentAt: Date;
  readonly now: Date;
}): boolean {
  return (
    !input.legalHold &&
    input.now.getTime() - input.sentAt.getTime() > input.retentionDays * 86_400_000
  );
}
