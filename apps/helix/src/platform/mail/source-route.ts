import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { NotFoundError } from "../../api/api-error.js";
import { requireActorScope } from "../../api/scopes.js";
import { safeDriveContentHeaders } from "../drive/content-security.js";
import type { MailRawSourceStore, MailStore } from "./store.js";

const sourceParamsSchema = z.object({ messageId: z.string().uuid() });
const sourceQuerySchema = z.object({ mailboxActorId: z.string().uuid().optional() });
const attachmentParamsSchema = z.object({
  messageId: z.string().uuid(),
  objectId: z.string().uuid(),
});
const attachmentQuerySchema = sourceQuerySchema.extend({
  /** Inline display for passive content (images); active content always downloads. */
  inline: z.enum(["true", "false"]).optional(),
});

export function registerMailSourceRoutes(
  app: FastifyInstance,
  options: {
    readonly store: MailRawSourceStore & Required<Pick<MailStore, "readMessageAttachment">>;
    readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
    /** Largest stored attachment served; an inbound attachment never exceeds the message cap. */
    readonly maxAttachmentBytes: number;
  },
): void {
  // Attachment bytes for a message in the caller's (or a delegated) mailbox.
  // Mail-ingested objects are served only after a clean antivirus verdict.
  app.get("/api/mail/messages/:messageId/attachments/:objectId", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    requireActorScope(actor, "mail.read");
    const { messageId, objectId } = attachmentParamsSchema.parse(request.params);
    const { mailboxActorId, inline } = attachmentQuerySchema.parse(request.query);
    const attachment = await options.store.readMessageAttachment({
      orgId: actor.orgId,
      actorId: mailboxActorId ?? actor.id,
      messageId,
      objectId,
      maxBytes: options.maxAttachmentBytes,
    });
    if (attachment === null) {
      throw new NotFoundError("Mail attachment not found.");
    }
    const headers = safeDriveContentHeaders(
      attachment.filename ?? "attachment",
      attachment.mimeType,
      inline === "true",
    );
    return reply
      .header("cache-control", "private, no-store")
      .header("content-disposition", headers.disposition)
      .header("content-length", String(attachment.content.byteLength))
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("x-content-type-options", "nosniff")
      .type(headers.mimeType)
      .send(attachment.content);
  });

  app.get("/api/mail/messages/:messageId/source", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    requireActorScope(actor, "mail.read");
    const { messageId } = sourceParamsSchema.parse(request.params);
    const { mailboxActorId } = sourceQuerySchema.parse(request.query);
    const source = await options.store.readRawSource({
      orgId: actor.orgId,
      actorId: mailboxActorId ?? actor.id,
      messageId,
    });
    if (source === null) {
      throw new NotFoundError("Mail source not found.");
    }
    return reply
      .header("cache-control", "private, no-store")
      .header("content-disposition", `attachment; filename="${messageId}.eml"`)
      .header("content-length", String(source.byteSize))
      .header("etag", `"sha256-${Buffer.from(source.sha256, "hex").toString("base64url")}"`)
      .header("x-content-type-options", "nosniff")
      .type("message/rfc822")
      .send(source.bytes);
  });
}
