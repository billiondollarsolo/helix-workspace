import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "@helix/sdk-types";
import { BadRequestError } from "../../api/api-error.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";

export interface AssistantRoutine {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly name: string;
  readonly prompt: string;
  readonly intervalMinutes: number;
  readonly enabled: boolean;
  readonly conversationId: string | null;
  readonly nextRunAt: string;
  readonly lastRunAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
}

export interface AssistantRoutineStore {
  create(input: {
    readonly actor: Actor;
    readonly name: string;
    readonly prompt: string;
    readonly intervalMinutes: number;
    readonly conversationId?: string;
  }): Promise<AssistantRoutine>;
  list(actor: Actor): Promise<readonly AssistantRoutine[]>;
  setEnabled(actor: Actor, id: string, enabled: boolean): Promise<AssistantRoutine | null>;
  claimDue(now: Date, limit: number): Promise<readonly AssistantRoutine[]>;
  markRun(id: string, result: { readonly error?: string; readonly nextRunAt: Date }): Promise<void>;
}

export class InMemoryRoutineStore implements AssistantRoutineStore {
  readonly #rows = new Map<string, AssistantRoutine>();

  async create(input: {
    readonly actor: Actor;
    readonly name: string;
    readonly prompt: string;
    readonly intervalMinutes: number;
    readonly conversationId?: string;
  }): Promise<AssistantRoutine> {
    const now = new Date();
    const row: AssistantRoutine = {
      id: randomUUID(),
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      name: input.name,
      prompt: input.prompt,
      intervalMinutes: input.intervalMinutes,
      enabled: true,
      conversationId: input.conversationId ?? null,
      nextRunAt: new Date(now.getTime() + input.intervalMinutes * 60_000).toISOString(),
      lastRunAt: null,
      lastError: null,
      createdAt: now.toISOString(),
    };
    this.#rows.set(row.id, row);
    return row;
  }

  async list(actor: Actor): Promise<readonly AssistantRoutine[]> {
    return [...this.#rows.values()].filter(
      (row) => row.orgId === actor.orgId && row.actorId === actor.id,
    );
  }

  async setEnabled(actor: Actor, id: string, enabled: boolean): Promise<AssistantRoutine | null> {
    const row = this.#rows.get(id);
    if (row === undefined || row.orgId !== actor.orgId || row.actorId !== actor.id) return null;
    const next = { ...row, enabled };
    this.#rows.set(id, next);
    return next;
  }

  async claimDue(now: Date, limit: number): Promise<readonly AssistantRoutine[]> {
    return [...this.#rows.values()]
      .filter((row) => row.enabled && row.nextRunAt <= now.toISOString())
      .slice(0, limit);
  }

  async markRun(
    id: string,
    result: { readonly error?: string; readonly nextRunAt: Date },
  ): Promise<void> {
    const row = this.#rows.get(id);
    if (row === undefined) return;
    this.#rows.set(id, {
      ...row,
      lastRunAt: new Date().toISOString(),
      lastError: result.error ?? null,
      nextRunAt: result.nextRunAt.toISOString(),
    });
  }
}

export function nextRunAt(from: Date, intervalMinutes: number): Date {
  return new Date(from.getTime() + intervalMinutes * 60_000);
}

export function registerRoutineTools(
  registry: RuntimeToolRegistry,
  store: AssistantRoutineStore,
): void {
  registry.register(
    defineTool({
      id: "routines.list",
      description: "List this actor's scheduled Assistant routines.",
      permission: "assistant.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(z.object({}).strict(), {
        type: "object",
        additionalProperties: false,
      }),
      outputSchema: zodToolSchema(z.unknown(), { type: "object", additionalProperties: true }),
      handler: async (_input, ctx) => ({ items: await store.list(ctx.actor) }),
    }),
  );
  registry.register(
    defineTool({
      id: "routines.create",
      description:
        "Schedule a repeating Assistant prompt for this user (interval 5–10080 minutes).",
      permission: "assistant.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(
        z
          .object({
            name: z.string().trim().min(1).max(80),
            prompt: z.string().trim().min(1).max(4_000),
            intervalMinutes: z.number().int().min(5).max(10_080),
          })
          .strict(),
        {
          type: "object",
          properties: {
            name: { type: "string" },
            prompt: { type: "string" },
            intervalMinutes: { type: "integer", minimum: 5, maximum: 10_080 },
          },
          required: ["name", "prompt", "intervalMinutes"],
          additionalProperties: false,
        },
      ),
      outputSchema: zodToolSchema(z.unknown(), { type: "object", additionalProperties: true }),
      handler: async (input, ctx) =>
        store.create({
          actor: ctx.actor,
          name: input.name,
          prompt: input.prompt,
          intervalMinutes: input.intervalMinutes,
        }),
    }),
  );
  registry.register(
    defineTool({
      id: "routines.set_enabled",
      description: "Pause or resume a scheduled Assistant routine.",
      permission: "assistant.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(
        z.object({ id: z.string().uuid(), enabled: z.boolean() }).strict(),
        {
          type: "object",
          properties: { id: { type: "string", format: "uuid" }, enabled: { type: "boolean" } },
          required: ["id", "enabled"],
          additionalProperties: false,
        },
      ),
      outputSchema: zodToolSchema(z.unknown(), { type: "object", additionalProperties: true }),
      handler: async ({ id, enabled }, ctx) => {
        const updated = await store.setEnabled(ctx.actor, id, enabled);
        if (updated === null) throw new BadRequestError("Routine was not found.");
        return updated;
      },
    }),
  );
}

export async function runDueRoutines(input: {
  readonly store: AssistantRoutineStore;
  readonly now?: Date;
  readonly run: (routine: AssistantRoutine) => Promise<void>;
}): Promise<number> {
  const now = input.now ?? new Date();
  const due = await input.store.claimDue(now, 20);
  for (const routine of due) {
    try {
      await input.run(routine);
      await input.store.markRun(routine.id, { nextRunAt: nextRunAt(now, routine.intervalMinutes) });
    } catch (error) {
      await input.store.markRun(routine.id, {
        error: error instanceof Error ? error.message : "Routine failed.",
        nextRunAt: nextRunAt(now, routine.intervalMinutes),
      });
    }
  }
  return due.length;
}
