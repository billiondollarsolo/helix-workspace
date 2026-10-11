/* Who a reply goes to, computed in the browser so the chips show it before
   sending. Mirrors the server rules: answer the latest message not sent by
   me; reply to its Reply-To or sender; Reply all adds the other To and Cc
   recipients; my own addresses never appear. */

import type { PersonRef } from "@/features/people/person-ref";
import type { MailThreadMessage } from "../api";
import { personRefFromMailAddress } from "./compose-fields";

export type ReplyMode = "reply" | "replyAll" | "forward";

type Mailbox = { readonly address: string; readonly name?: string };

const lower = (address: string) => address.trim().toLowerCase();

export function replyParent(
  messages: readonly MailThreadMessage[],
  own: ReadonlySet<string>,
): MailThreadMessage | undefined {
  const fromOthers = messages.filter(
    (message) => message.from === undefined || !own.has(lower(message.from.address)),
  );
  return fromOthers.at(-1) ?? messages.at(-1);
}

export function replyRecipients(
  parent: Pick<MailThreadMessage, "from" | "to" | "cc" | "replyTo">,
  own: ReadonlySet<string>,
  replyAll: boolean,
): { readonly to: PersonRef[]; readonly cc: PersonRef[] } {
  const sentByMe = parent.from !== undefined && own.has(lower(parent.from.address));
  const primary: readonly Mailbox[] = sentByMe
    ? parent.to
    : (parent.replyTo?.length ?? 0) > 0
      ? (parent.replyTo ?? [])
      : parent.from === undefined
        ? []
        : [parent.from];
  const seen = new Set(own);
  const take = (list: readonly Mailbox[]) =>
    list.flatMap((mailbox) => {
      const key = lower(mailbox.address);
      if (key === "" || seen.has(key)) return [];
      seen.add(key);
      return [personRefFromMailAddress(mailbox)];
    });
  const to = take(primary);
  if (!replyAll) return { to, cc: [] };
  return { to: [...to, ...(sentByMe ? [] : take(parent.to))], cc: take(parent.cc) };
}

/** `Re:` once, never `Re: Re:`. */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^re:/iu.test(trimmed) ? trimmed : `Re: ${trimmed}`.trim();
}

/** `Fwd:` once, never `Fwd: Fwd:`. */
export function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  return /^(?:fwd?|fw):/iu.test(trimmed) ? trimmed : `Fwd: ${trimmed}`.trim();
}

/** Whether Reply all would reach anyone beyond plain Reply. */
export function canReplyAll(
  parent: Pick<MailThreadMessage, "from" | "to" | "cc" | "replyTo"> | undefined,
  own: ReadonlySet<string>,
): boolean {
  if (parent === undefined) return false;
  const all = replyRecipients(parent, own, true);
  const one = replyRecipients(parent, own, false);
  return all.to.length + all.cc.length > one.to.length;
}
