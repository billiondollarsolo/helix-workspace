import type { MailAddress, MailThreadDetail, MailThreadMessage } from "./types.js";

/**
 * Pure reply / reply-all / forward composition over a visible thread.
 *
 * Callers load the thread through the actor-scoped `getThread`, so every
 * address and body used here is one the actor can already read.
 */

/** RFC 5322 §3.6.4 practice: keep the root plus the most recent ancestors. */
export const MAX_REFERENCES = 20;

type Mailbox = Pick<MailAddress, "address" | "name">;

export function lowerAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Parent for a reply: the requested message, else the latest one not sent by the actor. */
export function selectReplyParent(
  thread: Pick<MailThreadDetail, "messages">,
  ownAddresses: ReadonlySet<string>,
  messageId?: string,
): MailThreadMessage | undefined {
  if (messageId !== undefined) {
    return thread.messages.find((message) => message.id === messageId);
  }
  const fromOthers = thread.messages.filter(
    (message) =>
      message.from === undefined || !ownAddresses.has(lowerAddress(message.from.address)),
  );
  return fromOthers.at(-1) ?? thread.messages.at(-1);
}

/** In-Reply-To and capped References for a reply to `parent`. */
export function replyThreadingHeaders(
  parent: Pick<MailThreadMessage, "messageIdHeader" | "references">,
): {
  readonly inReplyTo?: string;
  readonly references: readonly string[];
} {
  const parentId = parent.messageIdHeader;
  const chain = [...(parent.references ?? []), ...(parentId === undefined ? [] : [parentId])];
  const unique = chain.filter((id, index) => chain.indexOf(id) === index);
  const references =
    unique.length <= MAX_REFERENCES
      ? unique
      : [unique[0] as string, ...unique.slice(unique.length - (MAX_REFERENCES - 1))];
  return { ...(parentId === undefined ? {} : { inReplyTo: parentId }), references };
}

/**
 * Recipients for reply / reply-all.
 *
 * Reply goes to Reply-To when present, else From. When the parent was sent by
 * the actor, the reply continues to that message's original recipients. Reply
 * all adds the parent's To/Cc. The actor's own addresses are always removed
 * and duplicates are folded case-insensitively.
 */
export function replyRecipients(
  parent: Pick<MailThreadMessage, "from" | "to" | "cc" | "replyTo">,
  ownAddresses: ReadonlySet<string>,
  replyAll: boolean,
): { readonly to: readonly Mailbox[]; readonly cc: readonly Mailbox[] } {
  const sentByActor =
    parent.from !== undefined && ownAddresses.has(lowerAddress(parent.from.address));
  const primary = sentByActor
    ? parent.to
    : (parent.replyTo?.length ?? 0) > 0
      ? (parent.replyTo ?? [])
      : parent.from === undefined
        ? []
        : [parent.from];
  const seen = new Set(ownAddresses);
  const take = (list: readonly Mailbox[]) =>
    list.flatMap((mailbox) => {
      const key = lowerAddress(mailbox.address);
      if (key.length === 0 || seen.has(key)) return [];
      seen.add(key);
      return [
        mailbox.name === undefined
          ? { address: mailbox.address }
          : { address: mailbox.address, name: mailbox.name },
      ];
    });
  const to = take(primary);
  if (!replyAll) return { to, cc: [] };
  const extraTo = sentByActor ? [] : take(parent.to);
  return { to: [...to, ...extraTo], cc: take(parent.cc) };
}

export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^re:/iu.test(trimmed) ? trimmed : `Re: ${trimmed}`.trim();
}

export function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  return /^(?:fwd?|fw):/iu.test(trimmed) ? trimmed : `Fwd: ${trimmed}`.trim();
}

function displayMailbox(mailbox: Mailbox): string {
  return mailbox.name === undefined ? mailbox.address : `${mailbox.name} <${mailbox.address}>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function plainBodyOf(message: MailThreadMessage): string {
  if (message.bodyFormat === "plain") return message.body;
  return (
    message.plainBody ??
    message.body
      .replace(/<(?:br|\/p|\/div)\s*\/?>/giu, "\n")
      .replace(/<[^>]*>/gu, "")
      .replaceAll("&nbsp;", " ")
  );
}

/** Quoted original (headers + body) appended to a forward, in text and HTML. */
export function forwardedContent(
  original: MailThreadMessage,
  subject: string,
): { readonly text: string; readonly html: string } {
  const headers: [string, string][] = [
    ["From", original.from === undefined ? "" : displayMailbox(original.from)],
    ["Date", original.sentAt.toUTCString()],
    ["Subject", original.subject ?? subject],
    ["To", original.to.map(displayMailbox).join(", ")],
    ...(original.cc.length === 0
      ? []
      : [["Cc", original.cc.map(displayMailbox).join(", ")] as [string, string]]),
  ];
  const text = [
    "---------- Forwarded message ---------",
    ...headers.map(([name, value]) => `${name}: ${value}`),
    "",
    plainBodyOf(original),
  ].join("\n");
  const body =
    original.bodyFormat === "html"
      ? original.body
      : `<div style="white-space:pre-wrap">${escapeHtml(original.body)}</div>`;
  const html = [
    '<div class="helix-mail-forward">',
    "<p>---------- Forwarded message ---------<br>",
    headers.map(([name, value]) => `${name}: ${escapeHtml(value)}`).join("<br>"),
    "</p>",
    `<blockquote>${body}</blockquote>`,
    "</div>",
  ].join("");
  return { text, html };
}

/** User text (optionally HTML) followed by the forwarded original. */
export function composeForwardBody(input: {
  readonly text: string;
  readonly html?: string | undefined;
  readonly original: MailThreadMessage;
  readonly subject: string;
}): { readonly text: string; readonly html: string } {
  const forwarded = forwardedContent(input.original, input.subject);
  const userHtml =
    input.html ??
    (input.text.length === 0
      ? ""
      : `<div>${escapeHtml(input.text).replaceAll("\n", "<br>")}</div>`);
  return {
    text: input.text.length === 0 ? forwarded.text : `${input.text}\n\n${forwarded.text}`,
    html: `${userHtml}<br>${forwarded.html}`,
  };
}
