import { createHash } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import { BadRequestError, ConflictError, NotFoundError } from "../../../api/api-error.js";
import { artifactView } from "./store.js";
import type { MailProductivityService } from "./service.js";

export async function fileMailAttachment(
  service: MailProductivityService,
  actor: Actor,
  input: { threadId: string; messageId: string; objectId: string; folderId: string },
) {
  const { store, mail, drive, classifyFile } = service.options;
  if (!drive || !mail.readMessageAttachment || !classifyFile)
    throw new BadRequestError(
      "Attachment filing is unavailable. Enable Drive and configure scanned storage and classification.",
    );
  const thread = await service.thread(actor, input.threadId);
  const message = thread.messages.find((item) => item.id === input.messageId);
  if (!message?.attachments.some((attachment) => attachment.objectId === input.objectId))
    throw new NotFoundError("Attachment is not in this conversation.");
  const sourceKey = `${input.messageId}:${input.objectId}:${input.folderId}`;
  const claim = await store.claim(actor, {
    kind: "filing",
    sourceKey,
    threadId: input.threadId,
    messageId: input.messageId,
  });
  if (claim) {
    try {
      const attachment = await mail.readMessageAttachment({
        orgId: actor.orgId,
        actorId: actor.id,
        messageId: input.messageId,
        objectId: input.objectId,
        maxBytes: 25 * 1024 * 1024,
      });
      if (!attachment)
        throw new NotFoundError("Attachment is unavailable or has not passed malware scanning.");
      const content = attachment.content;
      const sha256 = createHash("sha256").update(content).digest("hex");
      const name = (attachment.filename ?? "Email attachment")
        .replace(/[\\/\p{Cc}]/gu, "_")
        .slice(0, 250);
      let objectId = claim.object_id;
      if (objectId) {
        const moved = await drive.move({
          orgId: actor.orgId,
          actorId: actor.id,
          objectId,
          folderId: input.folderId,
        });
        if (!moved)
          throw new NotFoundError(
            "Filed copy or destination is unavailable. Restore access before retrying.",
          );
      } else {
        const prepared = await drive.prepareUpload({
          orgId: actor.orgId,
          actorId: actor.id,
          folderId: input.folderId,
          name,
          mimeType: attachment.mimeType,
          byteSize: content.length,
          sha256,
          metadata: {
            mailThreadId: input.threadId,
            mailMessageId: input.messageId,
            mailAttachmentId: input.objectId,
          },
        });
        objectId = prepared.objectId;
        await store.setObject(actor, claim, objectId);
      }
      await classifyFile({
        actor,
        resourceType: "file",
        resourceId: objectId,
        derivation: { explicit: await service.options.classifyThread(actor, thread), path: name },
      });
      await drive.finalizeUpload({
        orgId: actor.orgId,
        actorId: actor.id,
        objectId,
        byteSize: content.length,
        mimeType: attachment.mimeType,
        sha256,
        content,
        idempotencyKey: `mail-filing:${claim.id}`,
      });
      const status = await drive.getUploadStatus?.({
        orgId: actor.orgId,
        actorId: actor.id,
        objectId,
      });
      await store.finish(
        actor,
        claim,
        status?.available
          ? "Saved to Drive."
          : "Saved to Drive; processing or malware scanning is still pending.",
        objectId,
      );
    } catch (error) {
      await store.fail(actor, claim);
      throw error;
    }
  }
  const result = await store.find(actor, "filing", sourceKey);
  if (!result)
    throw new ConflictError("Filing record expired. Check Drive before attempting another copy.");
  return artifactView(result);
}
