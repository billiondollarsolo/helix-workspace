import type { JsonObject } from "@helix/sdk-types";
import type { AddressObject, ParsedMail } from "mailparser";
import { sanitizeMailHeaderDisplayValue, sanitizeMailHtml } from "./content-safety.js";
import type { MailAuthenticationSummary } from "./ingest.js";
import type {
  MailAddress,
  MailAttachmentInput,
  MailInboundRecipient,
  MailMessageInput,
} from "./types.js";

/**
 * Inbound headers kept on message metadata (`metadata.headers`, lower-case
 * keys). They drive RFC 3834 auto-reply suppression, reply addressing, and the
 * promotions category; everything else stays only in the raw source evidence.
 */
const INBOUND_HEADER_ALLOWLIST = [
  "auto-submitted",
  "precedence",
  "list-id",
  "list-unsubscribe",
  "reply-to",
  "x-auto-response-suppress",
  "return-path",
] as const;

const MAX_STORED_HEADER_LENGTH = 512;

/** Allowlisted, unfolded, control-free, length-capped inbound header values. */
export function inboundHeaderMap(
  headerLines: readonly { readonly key: string; readonly line: string }[] | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { key, line } of headerLines ?? []) {
    const name = key.toLowerCase();
    if (!(INBOUND_HEADER_ALLOWLIST as readonly string[]).includes(name) || name in headers) {
      continue;
    }
    const separator = line.indexOf(":");
    const value = sanitizeMailHeaderDisplayValue(
      separator === -1 ? "" : line.slice(separator + 1),
      MAX_STORED_HEADER_LENGTH,
    );
    if (value.length > 0) headers[name] = value;
  }
  return headers;
}

/** Read a stored header map, tolerating legacy flat metadata keys. */
export function storedHeaderMap(metadata: JsonObject | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  const headers = metadata?.headers;
  if (typeof headers === "object" && headers !== null && !Array.isArray(headers)) {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === "string") result[key.toLowerCase()] = value;
    }
  }
  if (typeof metadata?.precedence === "string" && !Object.hasOwn(result, "precedence"))
    result.precedence = metadata.precedence;
  if (typeof metadata?.autoSubmitted === "string" && !Object.hasOwn(result, "auto-submitted"))
    result["auto-submitted"] = metadata.autoSubmitted;
  return result;
}

export function addressObjectToList(
  value: AddressObject | AddressObject[] | undefined,
): MailAddress[] {
  const objects = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return objects
    .flatMap((object) =>
      object.value.map((address) => ({
        address: address.address ?? "",
        ...(address.name === "" ? {} : { name: sanitizeMailHeaderDisplayValue(address.name, 320) }),
      })),
    )
    .filter((address) => address.address.length > 0);
}

/**
 * Project parsed RFC 5322 mail onto a stored message. To/Cc keep every
 * address as received (they are the sender's visible headers); delivery and
 * visibility come only from `mailboxActorIds`, which lists this tenant's
 * resolved envelope recipients. Bcc is never reconstructed.
 */
export function parsedMailToMessage(
  input: {
    readonly orgId: string;
    readonly recipients: readonly MailInboundRecipient[];
    readonly envelopeFrom?: string | undefined;
    readonly providerDeliveryId?: string | undefined;
    readonly receivedAt?: Date | undefined;
  },
  parsed: ParsedMail,
  auth: MailAuthenticationSummary,
): MailMessageInput {
  const replyTo = addressObjectToList(parsed.replyTo);
  return {
    orgId: input.orgId,
    actorId: null,
    mailboxActorIds: input.recipients.map((recipient) => recipient.actorId),
    from: addressObjectToList(parsed.from)[0] ?? {
      address: input.envelopeFrom ?? "unknown@localhost",
    },
    to: addressObjectToList(parsed.to),
    cc: addressObjectToList(parsed.cc),
    bcc: [],
    subject: sanitizeMailHeaderDisplayValue(parsed.subject ?? ""),
    bodyText: parsed.text ?? "",
    ...(typeof parsed.html === "string" ? { bodyHtml: sanitizeMailHtml(parsed.html).html } : {}),
    messageId: parsed.messageId,
    ...(input.providerDeliveryId === undefined
      ? {}
      : { providerDeliveryId: input.providerDeliveryId }),
    inReplyTo: parsed.inReplyTo,
    references: Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references === undefined
        ? []
        : [parsed.references],
    receivedAt: input.receivedAt ?? new Date(),
    attachments: parsedAttachments(parsed),
    metadata: {
      direction: "inbound",
      auth: { ...auth },
      envelopeFrom: input.envelopeFrom ?? null,
      headers: inboundHeaderMap(parsed.headerLines),
      ...(replyTo.length === 0 ? {} : { replyTo }),
    },
  };
}

export function parsedAttachments(parsed: ParsedMail): readonly MailAttachmentInput[] {
  return parsed.attachments.map((attachment) => ({
    filename: attachment.filename,
    mimeType: attachment.contentType,
    content: attachment.content,
    contentId: attachment.cid,
    disposition: attachment.contentDisposition,
  }));
}
