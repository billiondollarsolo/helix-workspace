import type {
  Actor,
  JsonValue,
  PendingToolInvocation,
  RequestContext,
  ResourceRef,
  ToolContext,
  ToolDefinition,
} from "@helix/sdk";
import { randomUUID } from "node:crypto";
import { confirmationRequiredForSideEffect } from "../config/tier.js";
import type { TierSecurityDefaults } from "@helix/sdk";

export type ToolInvocationResult<Output> =
  | { readonly status: "executed"; readonly output: Output }
  | { readonly status: "pending_confirmation"; readonly pending: PendingToolInvocation };

export interface ConfirmationGate {
  queue(input: {
    readonly tool: ToolDefinition;
    readonly actor: Actor;
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
  recordExecution(input: {
    readonly id: string;
    readonly actor: Actor;
    readonly traceId?: string;
    readonly result?: JsonValue;
    readonly error?: string;
  }): Promise<PendingToolInvocation | null>;
  get(input: {
    readonly id: string;
    readonly actor: Actor;
  }): Promise<PendingToolInvocation | null>;
}

export interface PendingActionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly toolId: string;
  readonly input: JsonValue;
  readonly status: PendingToolInvocation["status"];
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly traceId: string | null;
  readonly result: JsonValue | null;
  readonly error: string | null;
}

export interface PendingActionCreateInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly toolId: string;
  readonly input: JsonValue;
  readonly expiresAt: Date;
  readonly createdAt?: Date;
  readonly traceId?: string;
}

export interface PendingActionStore {
  create(input: PendingActionCreateInput): Promise<PendingActionRecord>;
  get(id: string): Promise<PendingActionRecord | null>;
  decide(input: {
    readonly id: string;
    readonly actorId: string;
    readonly status: "confirmed" | "cancelled";
    readonly decidedAt: Date;
  }): Promise<PendingActionRecord | null>;
  recordExecution(input: {
    readonly id: string;
    readonly actorId: string;
    readonly traceId?: string;
    readonly result?: JsonValue;
    readonly error?: string;
  }): Promise<PendingActionRecord | null>;
  /**
   * Transitions every `pending_confirmation` record whose `expiresAt` is at or
   * before `now` to `expired`. Returns the records that were expired so the
   * caller can emit metrics / notifications. Implementations MUST be safe to
   * run concurrently (the leader-gated expiry worker is the canonical caller).
   */
  expireStale(input: { readonly now: Date; readonly limit?: number }): Promise<
    readonly PendingActionRecord[]
  >;
}

export interface ToolRegistryOptions {
  readonly tierDefaults: TierSecurityDefaults;
  readonly confirmationGate: ConfirmationGate;
  readonly contextFactory: (input: {
    readonly actor: Actor;
    readonly request?: RequestContext;
    readonly tool: ToolDefinition;
  }) => ToolContext;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  constructor(private readonly options: ToolRegistryOptions) {}

  register(tool: ToolDefinition): void {
    if (this.#tools.has(tool.id)) {
      throw new Error(`Tool already registered: ${tool.id}`);
    }
    this.#tools.set(tool.id, tool);
  }

  unregister(toolId: string): void {
    this.#tools.delete(toolId);
  }

  get(toolId: string): ToolDefinition | undefined {
    return this.#tools.get(toolId);
  }

  list(): readonly ToolDefinition[] {
    return [...this.#tools.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  requiresConfirmation(tool: ToolDefinition): boolean {
    return confirmationRequiredForSideEffect(
      tool.sideEffects,
      this.options.tierDefaults,
      tool.confirmationRequired,
    );
  }

  async invoke<Output = unknown>(input: {
    readonly toolId: string;
    readonly actor: Actor;
    readonly value: unknown;
    readonly request?: RequestContext;
    readonly resource?: ResourceRef;
  }): Promise<ToolInvocationResult<Output>> {
    const tool = this.#tools.get(input.toolId);
    if (tool === undefined) {
      throw new Error(`Unknown tool: ${input.toolId}`);
    }

    const parsedInput = tool.inputSchema.parse(input.value);
    const ctx = this.options.contextFactory({
      actor: input.actor,
      tool,
      ...(input.request === undefined ? {} : { request: input.request }),
    });
    await ctx.requirePermission(tool.permission, input.resource);

    if (this.requiresConfirmation(tool)) {
      const pending = await this.options.confirmationGate.queue({
        tool,
        actor: input.actor,
        input: toJsonValue(parsedInput),
        ...(input.request === undefined ? {} : { request: input.request }),
        ...(input.request?.traceId === undefined ? {} : { traceId: input.request.traceId }),
      });
      return { status: "pending_confirmation", pending };
    }

    const output = await tool.handler(parsedInput, ctx);
    return { status: "executed", output: tool.outputSchema.parse(output) as Output };
  }
}

/**
 * PRD §9.9 default confirmation window. Overridable per security tier via
 * {@link ConfirmationGateOptions.confirmationTimeoutMs}.
 */
export const defaultConfirmationTimeoutMs = 10 * 60 * 1000;

export interface ConfirmationGateOptions {
  readonly onPendingActionCreated?: (record: PendingActionRecord) => Promise<void>;
  /**
   * How long a queued action stays `pending_confirmation` before it is
   * eligible for expiry. Defaults to {@link defaultConfirmationTimeoutMs}
   * (10 minutes). Wire the per-tier value from config here.
   */
  readonly confirmationTimeoutMs?: number;
}

export class InMemoryConfirmationGate implements ConfirmationGate {
  private readonly confirmationTimeoutMs: number;

  constructor(
    private readonly store: PendingActionStore = new InMemoryPendingActionStore(),
    private readonly options: ConfirmationGateOptions = {},
  ) {
    this.confirmationTimeoutMs = options.confirmationTimeoutMs ?? defaultConfirmationTimeoutMs;
  }

  async queue(input: {
    readonly tool: ToolDefinition;
    readonly actor: Actor;
    readonly input: JsonValue;
    readonly request?: RequestContext;
    readonly traceId?: string;
  }): Promise<PendingToolInvocation> {
    const now = new Date();
    const record = await this.store.create({
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      toolId: input.tool.id,
      input: input.input,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.confirmationTimeoutMs),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    });
    await this.options.onPendingActionCreated?.(record);
    return pendingActionRecordToInvocation(record);
  }

  async approve(input: {
    readonly id: string;
    readonly actor: Actor;
    readonly decidedAt?: Date;
  }): Promise<PendingToolInvocation | null> {
    const record = await this.store.decide({
      id: input.id,
      actorId: input.actor.id,
      status: "confirmed",
      decidedAt: input.decidedAt ?? new Date(),
    });
    return record === null ? null : pendingActionRecordToInvocation(record);
  }

  async deny(input: {
    readonly id: string;
    readonly actor: Actor;
    readonly decidedAt?: Date;
  }): Promise<PendingToolInvocation | null> {
    const record = await this.store.decide({
      id: input.id,
      actorId: input.actor.id,
      status: "cancelled",
      decidedAt: input.decidedAt ?? new Date(),
    });
    return record === null ? null : pendingActionRecordToInvocation(record);
  }

  async recordExecution(input: {
    readonly id: string;
    readonly actor: Actor;
    readonly traceId?: string;
    readonly result?: JsonValue;
    readonly error?: string;
  }): Promise<PendingToolInvocation | null> {
    const record = await this.store.recordExecution({
      id: input.id,
      actorId: input.actor.id,
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.error === undefined ? {} : { error: input.error }),
    });
    return record === null ? null : pendingActionRecordToInvocation(record);
  }

  async get(input: {
    readonly id: string;
    readonly actor: Actor;
  }): Promise<PendingToolInvocation | null> {
    const record = await this.store.get(input.id);
    if (record === null || record.actorId !== input.actor.id || record.orgId !== input.actor.orgId) {
      return null;
    }
    return pendingActionRecordToInvocation(record);
  }
}

export class InMemoryPendingActionStore implements PendingActionStore {
  readonly #pending = new Map<string, PendingActionRecord>();

  async create(input: PendingActionCreateInput): Promise<PendingActionRecord> {
    const record: PendingActionRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      actorId: input.actorId,
      toolId: input.toolId,
      input: input.input,
      status: "pending_confirmation",
      createdAt: input.createdAt ?? new Date(),
      expiresAt: input.expiresAt,
      decidedAt: null,
      traceId: input.traceId ?? null,
      result: null,
      error: null,
    };
    this.#pending.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<PendingActionRecord | null> {
    return this.#pending.get(id) ?? null;
  }

  async decide(input: {
    readonly id: string;
    readonly actorId: string;
    readonly status: "confirmed" | "cancelled";
    readonly decidedAt: Date;
  }): Promise<PendingActionRecord | null> {
    const record = this.#pending.get(input.id);
    if (
      record === undefined ||
      record.actorId !== input.actorId ||
      record.status !== "pending_confirmation"
    ) {
      return null;
    }
    const decided: PendingActionRecord = {
      ...record,
      status: input.status,
      decidedAt: input.decidedAt,
    };
    this.#pending.set(input.id, decided);
    return decided;
  }

  async recordExecution(input: {
    readonly id: string;
    readonly actorId: string;
    readonly traceId?: string;
    readonly result?: JsonValue;
    readonly error?: string;
  }): Promise<PendingActionRecord | null> {
    const record = this.#pending.get(input.id);
    if (record === undefined || record.actorId !== input.actorId || record.status !== "confirmed") {
      return null;
    }
    const executed: PendingActionRecord = {
      ...record,
      traceId: input.traceId ?? record.traceId,
      result: input.result ?? null,
      error: input.error ?? null,
    };
    this.#pending.set(input.id, executed);
    return executed;
  }

  async expireStale(input: {
    readonly now: Date;
    readonly limit?: number;
  }): Promise<readonly PendingActionRecord[]> {
    const limit = input.limit ?? Number.POSITIVE_INFINITY;
    const expired: PendingActionRecord[] = [];
    for (const record of this.#pending.values()) {
      if (expired.length >= limit) {
        break;
      }
      if (record.status === "pending_confirmation" && record.expiresAt.getTime() <= input.now.getTime()) {
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

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function pendingActionRecordToInvocation(record: PendingActionRecord): PendingToolInvocation {
  return {
    id: record.id,
    toolId: record.toolId,
    actorId: record.actorId,
    input: record.input,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    ...(record.traceId === null ? {} : { traceId: record.traceId }),
  };
}
