/* Field model shared by the compose window and the inline reply: recipients
   are PeoplePicker chips, the body is sanitized HTML (or plain text in plain
   text mode), and everything converts to the mail tool wire shapes here. */

import type { MailAddress, MailDraft } from "@helix/contracts";
import {
  externalPersonRef,
  isValidEmailAddress,
  parseAddressList,
  type PersonRef,
} from "@/features/people/person-ref";
import type { MailAttachment } from "../api";
import type { ComposeInit } from "./compose-store";
import { composeHtmlToText, sanitizeComposeHtml, textToComposeHtml } from "./compose-html";

export type RecipientField = "to" | "cc" | "bcc";

export interface ComposeFields {
  readonly to: readonly PersonRef[];
  readonly cc: readonly PersonRef[];
  readonly bcc: readonly PersonRef[];
  readonly subject: string;
  /** Sanitized editor HTML; in plain text mode, escaped text with line breaks. */
  readonly html: string;
  readonly plainText: boolean;
  readonly attachments: readonly MailAttachment[];
}

export const EMPTY_COMPOSE_FIELDS: ComposeFields = {
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  html: "",
  plainText: false,
  attachments: [],
};

/** Address lists accept `a@x.com, Bo <b@y.org>` strings or one entry per item. */
export type AddressListInput = string | readonly string[];

function personRefsFromInput(input: AddressListInput | undefined): PersonRef[] {
  if (input === undefined) return [];
  return typeof input === "string"
    ? parseAddressList(input)
    : input.flatMap((entry) => parseAddressList(entry));
}

export function personRefFromMailAddress(address: MailAddress): PersonRef {
  return address.name === undefined || address.name.trim() === ""
    ? externalPersonRef(address.address)
    : { ...externalPersonRef(address.address), displayName: address.name };
}

/** The wire address for a chip; groups and members carry their mail address in `email`. */
function mailAddressFromRef(ref: PersonRef): MailAddress | null {
  if (ref.email === null || !isValidEmailAddress(ref.email)) return null;
  return ref.displayName.trim() === "" || ref.displayName === ref.email
    ? { address: ref.email }
    : { address: ref.email, name: ref.displayName };
}

export function mailAddressesFromRefs(refs: readonly PersonRef[]): MailAddress[] {
  return refs.flatMap((ref) => {
    const address = mailAddressFromRef(ref);
    return address === null ? [] : [address];
  });
}

/** Mail needs an address: a chip without a valid one (or a group without a list address) is invalid. */
function isMailRecipientValid(ref: PersonRef): boolean {
  return mailAddressFromRef(ref) !== null;
}

export interface RecipientProblem {
  readonly field: RecipientField;
  readonly message: string;
}

const FIELD_LABEL: Readonly<Record<RecipientField, string>> = { to: "To", cc: "Cc", bcc: "Bcc" };

/** The first problem that blocks sending, phrased so the person knows what to fix. */
export function recipientProblem(
  fields: Pick<ComposeFields, RecipientField>,
): RecipientProblem | null {
  for (const field of ["to", "cc", "bcc"] as const) {
    const invalid = fields[field].filter((ref) => !isMailRecipientValid(ref));
    if (invalid.length > 0) {
      const names = invalid.map((ref) => ref.email ?? ref.displayName).join(", ");
      return {
        field,
        message:
          invalid.length === 1
            ? `${FIELD_LABEL[field]}: "${names}" isn't a valid email address. Edit or remove it.`
            : `${FIELD_LABEL[field]}: ${names} aren't valid email addresses. Edit or remove them.`,
      };
    }
  }
  if (fields.to.length + fields.cc.length + fields.bcc.length === 0) {
    return { field: "to", message: "Add at least one recipient." };
  }
  return null;
}

function bodyText(fields: Pick<ComposeFields, "html">): string {
  return composeHtmlToText(fields.html);
}

export function hasComposeContent(fields: ComposeFields): boolean {
  return (
    fields.to.length + fields.cc.length + fields.bcc.length + fields.attachments.length > 0 ||
    fields.subject.trim() !== "" ||
    bodyText(fields).trim() !== ""
  );
}

/** Body fields for mail.send / mail.reply / mail.draft.save. */
export function wireBody(fields: Pick<ComposeFields, "html" | "plainText">): {
  readonly bodyText: string;
  readonly bodyHtml?: string;
} {
  const text = composeHtmlToText(fields.html);
  if (fields.plainText) return { bodyText: text };
  const html = sanitizeComposeHtml(fields.html);
  return text.trim() === "" ? { bodyText: text } : { bodyText: text, bodyHtml: html };
}

export function fieldsFromDraft(draft: MailDraft): ComposeFields {
  return {
    to: draft.to.map(personRefFromMailAddress),
    cc: draft.cc.map(personRefFromMailAddress),
    bcc: draft.bcc.map(personRefFromMailAddress),
    subject: draft.subject,
    html:
      draft.bodyHtml === undefined
        ? textToComposeHtml(draft.bodyText)
        : sanitizeComposeHtml(draft.bodyHtml),
    plainText: draft.bodyHtml === undefined && draft.bodyText !== "",
    attachments: draft.attachments,
  };
}

export function fieldsFromInit(init: ComposeInit): ComposeFields {
  return {
    to: personRefsFromInput(init.to),
    cc: personRefsFromInput(init.cc),
    bcc: personRefsFromInput(init.bcc),
    subject: init.subject ?? "",
    html:
      init.bodyHtml === undefined
        ? textToComposeHtml(init.body ?? "")
        : sanitizeComposeHtml(init.bodyHtml),
    plainText: init.plainText ?? false,
    attachments: init.attachments ?? [],
  };
}

/** A short "To" summary such as `Samara, Lee` for collapsed recipient rows. */
export function recipientSummary(refs: readonly PersonRef[]): string {
  return refs.map((ref) => ref.displayName || ref.email || "").join(", ");
}
