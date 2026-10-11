import type { OutboundMailMessage } from "@helix/sdk-types";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { DkimOptionsResolver } from "./outbound.js";
import type { MailOutboundEnvelope } from "./types.js";

/**
 * Wire formatting shared by every outbound transport.
 *
 * Display names are attacker-influenced (an outside sender's name is echoed by
 * vacation replies), so they never reach a transport as pre-formatted header
 * text that a parser could split into extra recipients. Nodemailer receives
 * `{ name, address }` objects; string-only HTTP APIs receive an RFC 5322
 * quoted-string with `\` and `"` escaped and CR/LF/NUL removed.
 */

export interface MailboxLike {
  readonly address: string;
  readonly name?: string | undefined;
}

/** Extra headers a caller may set on an outbound envelope (case-insensitive). */
const OUTBOUND_EXTRA_HEADER_NAMES = ["Auto-Submitted"] as const;

/** Outbound message plus Helix-only delivery hints the built-in providers honour. */
export type HelixOutboundMailMessage = Omit<OutboundMailMessage, "attachments"> & {
  readonly attachments?: readonly {
    readonly filename?: string;
    readonly contentType?: string;
    readonly contentId?: string;
    readonly content: Uint8Array;
  }[];
  /** SMTP RCPT TO list when it differs from the visible To/Cc/Bcc headers. */
  readonly envelopeRecipients?: readonly string[];
};

const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_HEADER_VALUE_LENGTH = 998;
// CR, LF, and NUL can terminate or forge header lines.
const HEADER_BREAKING = /[\r\n\0]/gu;

/** True when a display name would break out of its header line. */
export function hasHeaderBreakingCharacter(value: string): boolean {
  return /[\r\n\0]/u.test(value);
}

/** Strip CR/LF/NUL, collapse whitespace, and cap a display name. */
export function sanitizeDisplayName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const cleaned = name
    .replace(HEADER_BREAKING, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
  return cleaned.length === 0 ? undefined : cleaned;
}

/** RFC 5322 quoted-string form for APIs that only accept a mailbox string. */
export function formatMailboxAddress(mailbox: MailboxLike): string {
  const name = sanitizeDisplayName(mailbox.name);
  const address = mailbox.address.replace(HEADER_BREAKING, "");
  return name === undefined
    ? address
    : `"${name.replace(/[\\"]/gu, (character) => `\\${character}`)}" <${address}>`;
}

/** Structured mailbox for nodemailer, which encodes names itself. */
export function nodemailerMailbox(mailbox: MailboxLike): { name: string; address: string } {
  return { name: sanitizeDisplayName(mailbox.name) ?? "", address: mailbox.address };
}

/** Keep only allowlisted extra headers with single-line, bounded values. */
export function allowlistedOutboundHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const canonical = OUTBOUND_EXTRA_HEADER_NAMES.find(
      (allowed) => allowed.toLowerCase() === name.toLowerCase(),
    );
    if (canonical === undefined || typeof value !== "string") continue;
    const cleaned = value.replace(HEADER_BREAKING, " ").trim().slice(0, MAX_HEADER_VALUE_LENGTH);
    if (cleaned.length > 0) result[canonical] = cleaned;
  }
  return result;
}

/** Validate caller-supplied extra headers, failing on anything not allowlisted. */
export function assertAllowlistedOutboundHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): void {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (
      !OUTBOUND_EXTRA_HEADER_NAMES.some((allowed) => allowed.toLowerCase() === name.toLowerCase())
    )
      throw new TypeError(`Outbound header ${name} is not allowed.`);
    if (hasHeaderBreakingCharacter(value) || value.length > MAX_HEADER_VALUE_LENGTH)
      throw new TypeError(`Outbound header ${name} must be one line of at most 998 characters.`);
  }
}

/** Provider message headers: threading, idempotency, and allowlisted extras. */
export function outboundMessageHeaders(
  envelope: MailOutboundEnvelope,
  idempotencyKey: string,
): Record<string, string> {
  return {
    ...allowlistedOutboundHeaders(envelope.headers),
    "X-Helix-Idempotency-Key": idempotencyKey,
    ...(envelope.messageId === undefined ? {} : { "Message-ID": envelope.messageId }),
    ...(envelope.inReplyTo === undefined ? {} : { "In-Reply-To": envelope.inReplyTo }),
    ...(envelope.references === undefined ? {} : { References: envelope.references.join(" ") }),
  };
}

/** Nodemailer options for a provider message (SES and SMTP relay providers). */
export function toNodemailerMail(
  message: HelixOutboundMailMessage,
  dkim?: Awaited<ReturnType<DkimOptionsResolver>>,
): SMTPTransport.MailOptions {
  return {
    from: nodemailerMailbox(message.from),
    to: message.to.map(nodemailerMailbox),
    cc: message.cc.map(nodemailerMailbox),
    bcc: message.bcc.map(nodemailerMailbox),
    subject: message.subject,
    text: message.text,
    ...(message.html === undefined ? {} : { html: message.html }),
    ...(dkim === undefined || dkim === null ? {} : { dkim }),
    ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    ...(message.headers === undefined ? {} : { headers: { ...message.headers } }),
    ...(message.envelopeRecipients === undefined
      ? {}
      : {
          envelope: { from: message.from.address, to: [...message.envelopeRecipients] },
        }),
    attachments: (message.attachments ?? []).map((attachment) => ({
      ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
      ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
      ...(attachment.contentId === undefined ? {} : { cid: attachment.contentId }),
      content: Buffer.from(attachment.content),
    })),
  };
}
