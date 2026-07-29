import type { JsonObject } from "@helix/sdk-types";
import type { AttachmentObjectResolver } from "./outbound.js";
import type { MailDraftRecord, MailOutboundRecord } from "./types.js";

export type MailOutboundDisplayStatus =
  "queued" | "sending" | "sent" | "delayed" | "failed" | "cancelled";

export function mailOutboundDisplayStatus(
  outbound: Pick<MailOutboundRecord, "status" | "deliveryMetadata">,
): MailOutboundDisplayStatus {
  if (
    outbound.status === "sent" &&
    (outbound.deliveryMetadata.latestEvent === "delayed" ||
      outbound.deliveryMetadata.latestEvent === "soft_bounce")
  ) {
    return "delayed";
  }
  return outbound.status;
}

export interface LocalDraftRecovery {
  readonly draftId: string;
  readonly envelope: JsonObject;
  readonly basedOnServerVersion: number;
  readonly updatedAt: Date;
}

export type DraftRecoveryDecision =
  | {
      readonly kind: "use_server";
      readonly server: MailDraftRecord;
      readonly reason: "server_newer" | "same_version";
    }
  | {
      readonly kind: "requires_explicit_merge";
      readonly server: MailDraftRecord;
      readonly local: LocalDraftRecovery;
    };

/**
 * Server drafts are authoritative. Local crash recovery is never written over
 * a newer server version automatically; a newer local recovery requires an
 * explicit merge/save against the current server version.
 */
export function reconcileLocalDraftRecovery(
  server: MailDraftRecord,
  local: LocalDraftRecovery,
): DraftRecoveryDecision {
  if (
    server.version > local.basedOnServerVersion ||
    server.updatedAt.getTime() > local.updatedAt.getTime()
  ) {
    return { kind: "use_server", server, reason: "server_newer" };
  }
  if (
    server.version === local.basedOnServerVersion &&
    server.updatedAt.getTime() === local.updatedAt.getTime()
  ) {
    return { kind: "use_server", server, reason: "same_version" };
  }
  return { kind: "requires_explicit_merge", server, local };
}

export function createDispatchAuthorizedAttachmentResolver(options: {
  readonly readFile: (input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }) => Promise<{ readonly content?: Uint8Array | Buffer | null } | null>;
}): AttachmentObjectResolver {
  return async (objectId, context) => {
    const file = await options.readFile({ ...context, objectId });
    if (file?.content == null) {
      throw new MailAttachmentAccessRevokedError(objectId);
    }
    return Buffer.from(file.content);
  };
}

export class MailAttachmentAccessRevokedError extends Error {
  readonly retryable = false;

  constructor(readonly objectId: string) {
    super(`Attachment ${objectId} is unavailable or no longer authorized at dispatch time.`);
    this.name = "MailAttachmentAccessRevokedError";
  }
}
