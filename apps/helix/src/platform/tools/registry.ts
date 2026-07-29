import { randomUUID } from "node:crypto";
import type {
  Actor,
  JsonObject,
  JsonValue,
  PendingActionPreview,
  PendingToolInvocation,
  RequestContext,
  ToolDefinition,
} from "@helix/sdk";
import type { AgentCredentialPolicy } from "../auth/credentials.js";
import { buildSafeActionPreview, hashToolInput, policySnapshot } from "./automation-policy.js";

export interface PendingActionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly requesterActorId: string;
  /** Backwards-compatible storage alias for requesterActorId. */
  readonly actorId: string;
  readonly requesterCredentialId: string | null;
  readonly requesterPrincipal: Actor;
  readonly requesterIp: string | null;
  readonly approvalOwnerActorId: string | null;
  readonly approverActorId: string | null;
  readonly executionActorId: string | null;
  readonly toolId: string;
  readonly input: JsonValue;
  readonly inputHash: string;
  readonly policySnapshot: JsonObject;
  readonly policyVersion: string;
  readonly preview: PendingActionPreview;
  readonly status: PendingToolInvocation["status"];
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly approvedAt: Date | null;
  readonly executionStartedAt: Date | null;
  readonly executionCompletedAt: Date | null;
  readonly executionLeaseExpiresAt: Date | null;
  readonly executionAttempts: number;
  readonly executionIdempotencyKey: string;
  readonly traceId: string | null;
  readonly result: JsonValue | null;
  readonly error: string | null;
}

export type PendingActionCreateInput = Omit<
  PendingActionRecord,
  | "status"
  | "decidedAt"
  | "approvedAt"
  | "approverActorId"
  | "executionActorId"
  | "executionStartedAt"
  | "executionCompletedAt"
  | "executionLeaseExpiresAt"
  | "executionAttempts"
  | "result"
  | "error"
>;

export interface PendingActionStore {
  create(input: PendingActionCreateInput): Promise<PendingActionRecord>;
  get(id: string): Promise<PendingActionRecord | null>;
  approve(input: {
    readonly id: string;
    readonly approverActorId: string;
    readonly approvedAt: Date;
  }): Promise<PendingActionRecord | null>;
  cancel(input: {
    readonly id: string;
    readonly actorId: string;
    readonly cancelledAt: Date;
  }): Promise<PendingActionRecord | null>;
  claimExecution(input: {
    readonly id: string;
    readonly approverActorId: string;
    readonly executionActorId: string;
    readonly startedAt: Date;
    readonly leaseExpiresAt: Date;
  }): Promise<PendingActionRecord | null>;
  completeExecution(input: {
    readonly id: string;
    readonly executionActorId: string;
    readonly status: "executed" | "failed";
    readonly completedAt: Date;
    readonly traceId?: string;
    readonly result?: JsonValue;
    readonly error?: string;
  }): Promise<PendingActionRecord | null>;
  recoverStaleExecutions(input: {
    readonly now: Date;
    readonly limit?: number;
  }): Promise<readonly PendingActionRecord[]>;
  expireStale(input: {
    readonly now: Date;
    readonly limit?: number;
  }): Promise<readonly PendingActionRecord[]>;
}

export interface PendingExecutionClaim {
  readonly record: PendingActionRecord;
  readonly recovered: boolean;
}

export interface ConfirmationGate {
  queue(input: {
    readonly tool: ToolDefinition;
    readonly actor: Actor;
    readonly requesterCredentialId?: string;
    readonly approvalOwnerActorId?: string;
    readonly credentialPolicy?: AgentCredentialPolicy;
    readonly input: JsonValue;
    readonly request?: RequestContext;
    readonly traceId?: string;
  }): Promise<PendingToolInvocation>;
  approve(input: {
    readonly id: string;
    readonly actor: Actor;
    readonly decidedAt?: Date;
  }): Promise<PendingToolInvocation | null>;
  deny(input: {
    readonly id: string;
    readonly actor: Actor;
    readonly decidedAt?: Date;
  }): Promise<PendingToolInvocation | null>;
  get(input: { readonly id: string; readonly actor: Actor }): Promise<PendingToolInvocation | null>;
  getRecord(input: {
    readonly id: string;
    readonly actor: Actor;
  }): Promise<PendingActionRecord | null>;
  claimExecution(input: {
    readonly id: string;
    readonly approver: Actor;
    readonly executionActorId: string;
    readonly at?: Date;
  }): Promise<PendingExecutionClaim | null>;
  completeExecution(input: {
    readonly id: string;
    readonly executionActorId: string;
    readonly traceId?: string;
    readonly result?: JsonValue;
    readonly error?: string;
    readonly completedAt?: Date;
  }): Promise<PendingToolInvocation | null>;
}

export const defaultConfirmationTimeoutMs = 10 * 60 * 1000;
export const defaultExecutionLeaseMs = 60 * 1000;

export interface ConfirmationGateOptions {
  readonly onPendingActionCreated?: (record: PendingActionRecord) => Promise<void>;
  readonly onPendingActionChanged?: (record: PendingActionRecord) => Promise<void>;
  readonly confirmationTimeoutMs?: number;
  readonly executionLeaseMs?: number;
}

export class InMemoryConfirmationGate implements ConfirmationGate {
  private readonly confirmationTimeoutMs: number;
  private readonly executionLeaseMs: number;

  constructor(
    private readonly store: PendingActionStore = new InMemoryPendingActionStore(),
    private readonly options: ConfirmationGateOptions = {},
  ) {
    this.confirmationTimeoutMs = options.confirmationTimeoutMs ?? defaultConfirmationTimeoutMs;
    this.executionLeaseMs = options.executionLeaseMs ?? defaultExecutionLeaseMs;
  }

  async queue(input: {
    readonly tool: ToolDefinition;
    readonly actor: Actor;
    readonly requesterCredentialId?: string;
    readonly approvalOwnerActorId?: string;
    readonly credentialPolicy?: AgentCredentialPolicy;
    readonly input: JsonValue;
    readonly request?: RequestContext;
    readonly traceId?: string;
  }): Promise<PendingToolInvocation> {
    const now = new Date();
    const id = randomUUID();
    const record = await this.store.create({
      id,
      orgId: input.actor.orgId,
      requesterActorId: input.actor.id,
      actorId: input.actor.id,
      requesterCredentialId: input.requesterCredentialId ?? null,
      requesterPrincipal: input.actor,
      requesterIp: input.request?.ip ?? null,
      approvalOwnerActorId: input.approvalOwnerActorId ?? null,
      toolId: input.tool.id,
      input: input.input,
      inputHash: hashToolInput(input.input),
      policySnapshot: policySnapshot({
        ...(input.credentialPolicy?.version === undefined
          ? {}
          : { credentialPolicyVersion: input.credentialPolicy.version }),
        ...(input.credentialPolicy?.automationPolicy === undefined
          ? {}
          : { automationPolicy: input.credentialPolicy.automationPolicy }),
      }),
      policyVersion: input.credentialPolicy?.version ?? "actor-session",
      preview: buildSafeActionPreview(input.tool, input.input),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.confirmationTimeoutMs),
      executionIdempotencyKey: `pending-action:${id}`,
      traceId: input.traceId ?? null,
    });
    await this.options.onPendingActionCreated?.(record);
    return pendingActionRecordToInvocation(record);
  }

  async approve(input: {
    readonly id: string;
    readonly actor: Actor;
    readonly decidedAt?: Date;
  }): Promise<PendingToolInvocation | null> {
    const current = await this.store.get(input.id);
    const decidedAt = input.decidedAt ?? new Date();
    if (
      current === null ||
      !canApprove(current, input.actor) ||
      current.expiresAt.getTime() <= decidedAt.getTime()
    ) {
      return null;
    }
    const record = await this.store.approve({
      id: input.id,
      approverActorId: input.actor.id,
      approvedAt: decidedAt,
    });
    if (record !== null) {
      await this.options.onPendingActionChanged?.(record);
    }
    return record === null ? null : pendingActionRecordToInvocation(record);
  }

  async deny(input: {
    readonly id: string;
    readonly actor: Actor;
    readonly decidedAt?: Date;
  }): Promise<PendingToolInvocation | null> {
    const current = await this.store.get(input.id);
    if (current === null || !canCancel(current, input.actor)) {
      return null;
    }
    const record = await this.store.cancel({
      id: input.id,
      actorId: input.actor.id,
      cancelledAt: input.decidedAt ?? new Date(),
    });
    if (record !== null) {
      await this.options.onPendingActionChanged?.(record);
    }
    return record === null ? null : pendingActionRecordToInvocation(record);
  }

  async get(input: {
    readonly id: string;
    readonly actor: Actor;
  }): Promise<PendingToolInvocation | null> {
    const record = await this.getRecord(input);
    return record === null ? null : pendingActionRecordToInvocation(record);
  }

  async getRecord(input: {
    readonly id: string;
    readonly actor: Actor;
  }): Promise<PendingActionRecord | null> {
    const record = await this.store.get(input.id);
    if (record === null || !canView(record, input.actor)) {
      return null;
    }
    return record;
  }

  async claimExecution(input: {
    readonly id: string;
    readonly approver: Actor;
    readonly executionActorId: string;
    readonly at?: Date;
  }): Promise<PendingExecutionClaim | null> {
    const before = await this.store.get(input.id);
    const at = input.at ?? new Date();
    if (
      before === null ||
      before.approverActorId !== input.approver.id ||
      before.orgId !== input.approver.orgId ||
      before.expiresAt.getTime() <= at.getTime()
    ) {
      return null;
    }
    const record = await this.store.claimExecution({
      id: input.id,
      approverActorId: input.approver.id,
      executionActorId: input.executionActorId,
      startedAt: at,
      leaseExpiresAt: new Date(at.getTime() + this.executionLeaseMs),
    });
    if (record !== null) {
      await this.options.onPendingActionChanged?.(record);
    }
    return record === null ? null : { record, recovered: false };
  }

  async completeExecution(input: {
    readonly id: string;
    readonly executionActorId: string;
    readonly traceId?: string;
    readonly result?: JsonValue;
    readonly error?: string;
    readonly completedAt?: Date;
  }): Promise<PendingToolInvocation | null> {
    const record = await this.store.completeExecution({
      id: input.id,
      executionActorId: input.executionActorId,
      status: input.error === undefined ? "executed" : "failed",
      completedAt: input.completedAt ?? new Date(),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.error === undefined ? {} : { error: input.error }),
    });
    if (record !== null) {
      await this.options.onPendingActionChanged?.(record);
    }
    return record === null ? null : pendingActionRecordToInvocation(record);
  }
}

export class InMemoryPendingActionStore implements PendingActionStore {
  readonly #pending = new Map<string, PendingActionRecord>();

  async create(input: PendingActionCreateInput): Promise<PendingActionRecord> {
    const record: PendingActionRecord = {
      ...input,
      status: "pending_confirmation",
      approverActorId: null,
      executionActorId: null,
      decidedAt: null,
      approvedAt: null,
      executionStartedAt: null,
      executionCompletedAt: null,
      executionLeaseExpiresAt: null,
      executionAttempts: 0,
      result: null,
      error: null,
    };
    this.#pending.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<PendingActionRecord | null> {
    return this.#pending.get(id) ?? null;
  }

  async approve(input: {
    readonly id: string;
    readonly approverActorId: string;
    readonly approvedAt: Date;
  }): Promise<PendingActionRecord | null> {
    const record = this.#pending.get(input.id);
    if (
      record === undefined ||
      record.status !== "pending_confirmation" ||
      record.expiresAt <= input.approvedAt
    ) {
      return null;
    }
    const approved: PendingActionRecord = {
      ...record,
      status: "approved",
      approverActorId: input.approverActorId,
      approvedAt: input.approvedAt,
      decidedAt: input.approvedAt,
    };
    this.#pending.set(input.id, approved);
    return approved;
  }

  async cancel(input: {
    readonly id: string;
    readonly actorId: string;
    readonly cancelledAt: Date;
  }): Promise<PendingActionRecord | null> {
    const record = this.#pending.get(input.id);
    if (
      record === undefined ||
      (record.status !== "pending_confirmation" && record.status !== "approved")
    ) {
      return null;
    }
    const cancelled: PendingActionRecord = {
      ...record,
      status: "cancelled",
      decidedAt: input.cancelledAt,
    };
    this.#pending.set(input.id, cancelled);
    return cancelled;
  }

  async claimExecution(input: {
    readonly id: string;
    readonly approverActorId: string;
    readonly executionActorId: string;
    readonly startedAt: Date;
    readonly leaseExpiresAt: Date;
  }): Promise<PendingActionRecord | null> {
    const record = this.#pending.get(input.id);
    if (
      record === undefined ||
      record.approverActorId !== input.approverActorId ||
      record.expiresAt <= input.startedAt ||
      record.status !== "approved"
    ) {
      return null;
    }
    const executing: PendingActionRecord = {
      ...record,
      status: "executing",
      executionActorId: input.executionActorId,
      executionStartedAt: input.startedAt,
      executionLeaseExpiresAt: input.leaseExpiresAt,
      executionAttempts: record.executionAttempts + 1,
    };
    this.#pending.set(input.id, executing);
    return executing;
  }

  async completeExecution(input: {
    readonly id: string;
    readonly executionActorId: string;
    readonly status: "executed" | "failed";
    readonly completedAt: Date;
    readonly traceId?: string;
    readonly result?: JsonValue;
    readonly error?: string;
  }): Promise<PendingActionRecord | null> {
    const record = this.#pending.get(input.id);
    if (
      record === undefined ||
      record.status !== "executing" ||
      record.executionActorId !== input.executionActorId
    ) {
      return null;
    }
    const completed: PendingActionRecord = {
      ...record,
      status: input.status,
      traceId: input.traceId ?? record.traceId,
      result: input.result ?? null,
      error: input.error ?? null,
      executionCompletedAt: input.completedAt,
      executionLeaseExpiresAt: null,
    };
    this.#pending.set(input.id, completed);
    return completed;
  }

  async recoverStaleExecutions(input: {
    readonly now: Date;
    readonly limit?: number;
  }): Promise<readonly PendingActionRecord[]> {
    const limit = input.limit ?? Number.POSITIVE_INFINITY;
    const recovered: PendingActionRecord[] = [];
    for (const record of this.#pending.values()) {
      if (recovered.length >= limit) break;
      if (
        record.status === "executing" &&
        record.executionLeaseExpiresAt !== null &&
        record.executionLeaseExpiresAt <= input.now
      ) {
        const failed: PendingActionRecord = {
          ...record,
          status: "failed",
          error: "execution_outcome_unknown",
          executionCompletedAt: input.now,
          executionLeaseExpiresAt: null,
        };
        this.#pending.set(record.id, failed);
        recovered.push(failed);
      }
    }
    return recovered;
  }

  async expireStale(input: {
    readonly now: Date;
    readonly limit?: number;
  }): Promise<readonly PendingActionRecord[]> {
    const limit = input.limit ?? Number.POSITIVE_INFINITY;
    const expired: PendingActionRecord[] = [];
    for (const record of this.#pending.values()) {
      if (expired.length >= limit) break;
      if (
        (record.status === "pending_confirmation" || record.status === "approved") &&
        record.expiresAt <= input.now
      ) {
        const next: PendingActionRecord = {
          ...record,
          status: "expired",
          decidedAt: input.now,
        };
        this.#pending.set(record.id, next);
        expired.push(next);
      }
    }
    return expired;
  }
}

function canView(record: PendingActionRecord, actor: Actor): boolean {
  if (record.orgId !== actor.orgId) return false;
  return actor.id === record.requesterActorId || canApprove(record, actor);
}

function canApprove(record: PendingActionRecord, actor: Actor): boolean {
  if (record.orgId !== actor.orgId) return false;
  if (record.requesterPrincipal.type === "agent") {
    if (actor.type !== "user" || actor.id === record.requesterActorId) return false;
    return actor.id === record.approvalOwnerActorId || hasPendingApprovalAdminScope(actor);
  }
  return (
    actor.type === "user" &&
    (actor.id === record.requesterActorId || hasPendingApprovalAdminScope(actor))
  );
}

function hasPendingApprovalAdminScope(actor: Actor): boolean {
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

function canCancel(record: PendingActionRecord, actor: Actor): boolean {
  return (
    record.orgId === actor.orgId &&
    (actor.id === record.requesterActorId || canApprove(record, actor))
  );
}

function pendingActionRecordToInvocation(record: PendingActionRecord): PendingToolInvocation {
  return {
    id: record.id,
    toolId: record.toolId,
    actorId: record.requesterActorId,
    requesterActorId: record.requesterActorId,
    ...(record.requesterCredentialId === null
      ? {}
      : { requesterCredentialId: record.requesterCredentialId }),
    ...(record.approverActorId === null ? {} : { approverActorId: record.approverActorId }),
    ...(record.executionActorId === null ? {} : { executionActorId: record.executionActorId }),
    preview: record.preview,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    ...(record.approvedAt === null ? {} : { approvedAt: record.approvedAt.toISOString() }),
    ...(record.executionStartedAt === null
      ? {}
      : { executionStartedAt: record.executionStartedAt.toISOString() }),
    ...(record.executionCompletedAt === null
      ? {}
      : { executionCompletedAt: record.executionCompletedAt.toISOString() }),
    ...(record.traceId === null ? {} : { traceId: record.traceId }),
  };
}
