import type { AgentCredentialPolicy } from "../auth/credentials.js";
import { isJsonObject, type Actor, type PendingToolInvocation } from "@helix/sdk-types";
import { pendingMailReviewSchema } from "@helix/contracts";
import type { ConfirmationGate, PendingActionRecord } from "./registry.js";
import { redactActionInput } from "./sensitive-output.js";
import { hashToolInput } from "./automation-policy.js";

export type PendingActionReadOptions = {
  readonly actor: Actor;
  readonly includeMailReview?: boolean;
  readonly resourceRead?: {
    readonly toolId: string;
    readonly uri: string;
    readonly credentialId: string | null;
    readonly policyVersion: string;
  };
};
export type PendingActionReadResult =
  | {
      readonly ok: true;
      readonly pending: PendingToolInvocation;
      readonly review?:
        | ReturnType<typeof pendingMailReviewSchema.parse>
        | {
            readonly kind: "action";
            readonly input: unknown;
            readonly preview: PendingToolInvocation["preview"];
            readonly sourceIds: readonly string[];
          };
    }
  | { readonly ok: false; readonly statusCode: number; readonly error: string };

export async function readPendingAction(
  gate: ConfirmationGate | undefined,
  pendingId: string,
  readOptions: PendingActionReadOptions,
): Promise<PendingActionReadResult> {
  if (readOptions.includeMailReview === true && readOptions.actor.type !== "user") {
    return { ok: false, statusCode: 403, error: "Action review requires a signed-in person." };
  }
  if (gate === undefined) {
    return { ok: false, statusCode: 400, error: "Confirmation gate is not configured." };
  }
  const pending = await gate.get({
    id: pendingId,
    actor: readOptions.actor,
  });
  if (pending === null) {
    return {
      ok: false,
      statusCode: 404,
      error: `Pending tool action was not found: ${pendingId}`,
    };
  }
  if (readOptions.resourceRead !== undefined) {
    const record = await gate.getRecord({ id: pendingId, actor: readOptions.actor });
    const read = readOptions.resourceRead;
    if (
      record === null ||
      record.requesterActorId !== readOptions.actor.id ||
      record.status !== "executed" ||
      record.expiresAt <= new Date() ||
      record.toolId !== read.toolId ||
      !record.toolId.endsWith(".resource.read") ||
      record.requesterCredentialId !== read.credentialId ||
      record.policyVersion !== read.policyVersion ||
      !isJsonObject(record.input) ||
      hashToolInput(record.input) !== record.inputHash ||
      record.input.uri !== read.uri
    ) {
      return {
        ok: false,
        statusCode: 403,
        error:
          "Resource approval is missing, expired, or belongs to a different request or credential policy.",
      };
    }
  }
  if (readOptions.includeMailReview === true) {
    const record = await gate.getRecord({ id: pendingId, actor: readOptions.actor });
    if (record === null)
      return { ok: false, statusCode: 404, error: "Pending action was not found." };
    return {
      ok: true,
      pending,
      review:
        record.toolId === "mail.send"
          ? pendingMailReviewSchema.parse(record.input)
          : {
              kind: "action",
              input: redactActionInput(record.input),
              preview: record.preview,
              sourceIds: Array.isArray(record.policySnapshot.sourceIds)
                ? record.policySnapshot.sourceIds.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [],
            },
    };
  }
  return { ok: true, pending };
}

export interface PendingExecutionPrincipal {
  readonly actor: Actor;
  readonly credentialId?: string;
  readonly credentialOwnerActorId?: string;
  readonly credentialPolicy?: AgentCredentialPolicy;
}

export function pendingPrincipalStillAuthorized(
  principal: PendingExecutionPrincipal,
  record: PendingActionRecord,
  approver: Actor,
): boolean {
  if (
    principal.actor.id !== record.requesterActorId ||
    principal.actor.orgId !== record.orgId ||
    (principal.credentialPolicy?.version ?? "actor-session") !== record.policyVersion
  ) {
    return false;
  }
  if (record.requesterCredentialId === null) {
    return true;
  }
  return (
    principal.credentialId === record.requesterCredentialId &&
    (principal.credentialOwnerActorId === approver.id || actorIsOrgAdmin(approver))
  );
}

function actorIsOrgAdmin(actor: Actor): boolean {
  return (
    actor.type === "user" &&
    (actor.scopes ?? []).some(
      (scope) =>
        scope === "*" ||
        scope === "admin.*" ||
        scope === "admin.agents" ||
        scope === "admin.console.write",
    )
  );
}
