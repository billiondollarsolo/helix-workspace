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
