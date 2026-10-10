import { MailDeliveryError } from "./errors.js";
import { formatMailboxAddress, type HelixOutboundMailMessage } from "./outbound-format.js";

/**
 * Request bodies for the string-based HTTP mail APIs (Mailgun, Postmark).
 *
 * Both APIs derive SMTP recipients from the visible To/Cc/Bcc fields, so they
 * cannot carry a separate SMTP envelope; {@link ProviderMailTransport} narrows
 * the visible recipients for them instead. Attachments are always sent; a part
 * a provider cannot carry fails the send rather than silently dropping it.
 */

/** Postmark rejects these extensions outright; fail before the API call. */
const POSTMARK_FORBIDDEN_EXTENSIONS = new Set([
  "bat",
  "bin",
  "chm",
  "com",
  "cpl",
  "crt",
  "exe",
  "hlp",
  "hta",
  "inf",
  "ins",
  "isp",
  "jse",
  "lnk",
  "mdb",
  "msc",
  "msi",
  "msp",
  "mst",
  "pcd",
  "pif",
  "reg",
  "scr",
  "sct",
  "shs",
  "vba",
  "vbe",
  "vbs",
  "wsf",
  "wsh",
  "wsl",
]);

export interface EncodedHttpBody {
  readonly body: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
}

/** Mailgun `messages` multipart body, including attachments and cid parts. */
export async function mailgunMessageBody(
  message: HelixOutboundMailMessage,
): Promise<EncodedHttpBody> {
  const form = new FormData();
  form.set("from", formatMailboxAddress(message.from));
  for (const recipient of message.to) form.append("to", formatMailboxAddress(recipient));
  for (const recipient of message.cc) form.append("cc", formatMailboxAddress(recipient));
  for (const recipient of message.bcc) form.append("bcc", formatMailboxAddress(recipient));
  form.set("subject", message.subject);
  form.set("text", message.text);
  if (message.html !== undefined) form.set("html", message.html);
  if (message.replyTo !== undefined) form.set("h:Reply-To", message.replyTo);
  for (const [name, value] of Object.entries(message.headers ?? {})) form.set(`h:${name}`, value);
  for (const [index, attachment] of (message.attachments ?? []).entries()) {
    const blob = new Blob([Buffer.from(attachment.content)], {
      type: attachment.contentType ?? "application/octet-stream",
    });
    // Mailgun addresses inline parts by their filename, so the cid is the name.
    if (attachment.contentId !== undefined) {
      form.append("inline", blob, stripAngles(attachment.contentId));
    } else {
      form.append("attachment", blob, attachment.filename ?? `attachment-${String(index + 1)}`);
    }
  }
  const encoded = new Response(form);
  const contentType = encoded.headers.get("content-type");
  if (contentType === null) {
    throw new MailDeliveryError("Mailgun request could not be encoded.", false);
  }
  return { body: new Uint8Array(await encoded.arrayBuffer()), contentType };
}

/** Postmark `/email` JSON body, including base64 attachments. */
export function postmarkMessageBody(
  message: HelixOutboundMailMessage,
  messageStream: string,
): string {
  const headers = Object.entries(message.headers ?? {});
  const attachments = (message.attachments ?? []).map((attachment, index) => {
    const name = attachment.filename ?? `attachment-${String(index + 1)}`;
    const extension = name.includes(".") ? name.split(".").pop()?.toLowerCase() : undefined;
    if (extension !== undefined && POSTMARK_FORBIDDEN_EXTENSIONS.has(extension)) {
      throw new MailDeliveryError(
        `Postmark cannot deliver .${extension} attachments; remove ${name} or use an SMTP or SES provider.`,
        false,
      );
    }
    return {
      Name: name,
      Content: Buffer.from(attachment.content).toString("base64"),
      ContentType: attachment.contentType ?? "application/octet-stream",
      ...(attachment.contentId === undefined
        ? {}
        : { ContentID: `cid:${stripAngles(attachment.contentId)}` }),
    };
  });
  return JSON.stringify({
    From: formatMailboxAddress(message.from),
    To: message.to.map(formatMailboxAddress).join(", "),
    Subject: message.subject,
    TextBody: message.text,
    MessageStream: messageStream,
    ...(message.cc.length > 0 ? { Cc: message.cc.map(formatMailboxAddress).join(", ") } : {}),
    ...(message.bcc.length > 0 ? { Bcc: message.bcc.map(formatMailboxAddress).join(", ") } : {}),
    ...(message.html === undefined ? {} : { HtmlBody: message.html }),
    ...(message.replyTo === undefined ? {} : { ReplyTo: message.replyTo }),
    ...(headers.length > 0
      ? { Headers: headers.map(([name, value]) => ({ Name: name, Value: value })) }
      : {}),
    ...(attachments.length > 0 ? { Attachments: attachments } : {}),
  });
}

function stripAngles(contentId: string): string {
  return contentId.trim().replace(/^<|>$/gu, "");
}
