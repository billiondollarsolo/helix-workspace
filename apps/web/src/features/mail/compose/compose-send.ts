/* One send path for new messages, replies, and forwards. Replies always send
   the recipients shown in the chips (never re-derived on the server), so
   removing someone from Reply all really removes them. */

import { forwardMail, replyToMail, sendMail, type MailSendResult } from "../api";
import { mailAddressesFromRefs, wireBody, type ComposeFields } from "./compose-fields";
import type { DraftRef } from "./use-draft-autosave";

export type ComposeTarget =
  | { readonly kind: "new" }
  | { readonly kind: "reply"; readonly threadId: string; readonly messageId?: string }
  | {
      readonly kind: "forward";
      readonly threadId: string;
      readonly messageId: string;
      readonly includeAttachments: boolean;
    };

export interface ComposeSendInput {
  readonly target: ComposeTarget;
  readonly fields: ComposeFields;
  readonly from: string;
  readonly draft: DraftRef | null;
  readonly sendAt?: Date;
  readonly idempotencyKey: string;
}

export function sendComposed(input: ComposeSendInput): Promise<MailSendResult> {
  const { target, fields } = input;
  const shared = {
    ...(input.from === "" ? {} : { from: { address: input.from } }),
    to: mailAddressesFromRefs(fields.to),
    cc: mailAddressesFromRefs(fields.cc),
    bcc: mailAddressesFromRefs(fields.bcc),
    subject: fields.subject,
    ...wireBody(fields),
    attachments: fields.attachments,
    idempotencyKey: input.idempotencyKey,
    ...(input.sendAt === undefined ? {} : { sendAt: input.sendAt.toISOString() }),
  };
  const draft = input.draft === null ? {} : { draft: input.draft };
  switch (target.kind) {
    case "new":
      return sendMail({ ...shared, ...draft });
    case "reply":
      return replyToMail({
        ...shared,
        ...draft,
        threadId: target.threadId,
        ...(target.messageId === undefined ? {} : { messageId: target.messageId }),
      });
    case "forward":
      return forwardMail({
        ...shared,
        threadId: target.threadId,
        messageId: target.messageId,
        includeAttachments: target.includeAttachments,
      });
  }
}
