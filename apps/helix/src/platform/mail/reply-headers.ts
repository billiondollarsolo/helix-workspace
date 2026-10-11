import type { MailStore } from "./store.js";

/**
 * Fill RFC 5322 reply headers the caller left out from the thread, so replies to
 * other mail systems thread there: "Re: <subject>", In-Reply-To the latest
 * visible message, and References extended with it.
 */
export async function replyHeaders(
  input: {
    readonly threadId: string;
    readonly subject?: string | undefined;
    readonly inReplyTo?: string | undefined;
    readonly references: readonly string[];
  },
  actor: { readonly id: string; readonly orgId: string },
  store: Pick<MailStore, "getReplyContext">,
): Promise<{
  readonly subject: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
}> {
  const context = await store.getReplyContext?.({
    orgId: actor.orgId,
    actorId: actor.id,
    threadId: input.threadId,
  });
  const subject =
    input.subject ??
    (context === undefined || context === null
      ? "Re:"
      : /^re:/iu.test(context.subject.trim())
        ? context.subject
        : `Re: ${context.subject}`.trim());
  const inReplyTo = input.inReplyTo ?? context?.messageId;
  const references =
    input.references.length > 0
      ? input.references
      : [
          ...new Set([
            ...(context?.references ?? []),
            ...(context?.messageId === undefined ? [] : [context.messageId]),
          ]),
        ];
  return { subject, ...(inReplyTo === undefined ? {} : { inReplyTo }), references };
}
