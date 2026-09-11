import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isJsonObject, type JsonObject } from "@helix/sdk-types";
import { BadRequestError } from "../../api/api-error.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";

export const taskStatuses = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export interface ConversationTask {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
}

export function tasksFromMetadata(metadata: JsonObject): ConversationTask[] {
  const value = metadata.tasks;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isJsonObject(entry) || typeof entry.id !== "string" || typeof entry.title !== "string")
      return [];
    const status = taskStatuses.find((item) => item === entry.status) ?? "pending";
    return [{ id: entry.id, title: entry.title, status }];
  });
}

export function createTasks(
  metadata: JsonObject,
  titles: readonly string[],
): { readonly tasks: ConversationTask[]; readonly metadata: JsonObject } {
  const existing = tasksFromMetadata(metadata);
  const created = titles
    .map((title) => title.trim())
    .filter((title) => title.length > 0)
    .slice(0, 20)
    .map((title) => ({ id: randomUUID(), title: title.slice(0, 200), status: "pending" as const }));
  if (created.length === 0) throw new BadRequestError("Provide at least one task title.");
  const tasks = [...existing, ...created].slice(0, 40);
  return { tasks, metadata: { ...metadata, tasks: JSON.parse(JSON.stringify(tasks)) as JsonObject } };
}

export function updateTask(
  metadata: JsonObject,
  id: string,
  status: TaskStatus,
): { readonly tasks: ConversationTask[]; readonly metadata: JsonObject } {
  const tasks = tasksFromMetadata(metadata);
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) throw new BadRequestError("Task was not found in this conversation.");
  const next = tasks.map((task, taskIndex) => (taskIndex === index ? { ...task, status } : task));
  return {
    tasks: next,
    metadata: { ...metadata, tasks: JSON.parse(JSON.stringify(next)) as JsonObject },
  };
}

export function registerTaskTools(registry: RuntimeToolRegistry): void {
  registry.register(
    defineTool({
      id: "tasks.list",
      description: "List the checklist for the current Assistant conversation.",
      permission: "assistant.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(z.object({}).strict(), {
        type: "object",
        additionalProperties: false,
      }),
      outputSchema: zodToolSchema(z.unknown(), { type: "object", additionalProperties: true }),
      handler: async () => {
        throw new BadRequestError("tasks.list is only available inside Assistant.");
      },
    }),
  );
  registry.register(
    defineTool({
      id: "tasks.create",
      description:
        "Create a checklist of steps for this conversation. Call once at the start of multi-step work.",
      permission: "assistant.write",
      sideEffects: "read",
      inputSchema: zodToolSchema(
        z.object({ titles: z.array(z.string().trim().min(1).max(200)).min(1).max(20) }).strict(),
        {
          type: "object",
          properties: { titles: { type: "array", items: { type: "string" }, minItems: 1 } },
          required: ["titles"],
          additionalProperties: false,
        },
      ),
      outputSchema: zodToolSchema(z.unknown(), { type: "object", additionalProperties: true }),
      handler: async () => {
        throw new BadRequestError("tasks.create is only available inside Assistant.");
      },
    }),
  );
  registry.register(
    defineTool({
      id: "tasks.update",
      description: "Update one checklist item by id (pending, in_progress, completed, cancelled).",
      permission: "assistant.write",
      sideEffects: "read",
      inputSchema: zodToolSchema(
        z.object({ id: z.string().uuid(), status: z.enum(taskStatuses) }).strict(),
        {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            status: { type: "string", enum: [...taskStatuses] },
          },
          required: ["id", "status"],
          additionalProperties: false,
        },
      ),
      outputSchema: zodToolSchema(z.unknown(), { type: "object", additionalProperties: true }),
      handler: async () => {
        throw new BadRequestError("tasks.update is only available inside Assistant.");
      },
    }),
  );
}
