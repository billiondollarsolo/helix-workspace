import { z } from "zod";
import { isJsonObject, type JsonObject } from "@helix/sdk-types";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";

const fieldSchema = z
  .object({
    id: z.string().trim().min(1).max(40),
    label: z.string().trim().min(1).max(200),
    type: z.enum(["text", "select", "boolean"]).optional(),
    options: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  })
  .strict();

export function answersFromMetadata(metadata: JsonObject | undefined): JsonObject {
  if (metadata === undefined) return {};
  const raw = isJsonObject(metadata.answers) ? metadata.answers : metadata;
  const answers: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.length === 0 || key.length > 40) continue;
    if (typeof value === "boolean") answers[key] = value;
    else if (typeof value === "string") answers[key] = value.slice(0, 2_000);
  }
  return answers;
}

/** Overlay user form answers onto the approved ask.user tool result. */
export function askUserResult(toolId: string, output: unknown, metadata?: JsonObject): unknown {
  if (toolId !== "ask.user") return output;
  const answers = answersFromMetadata(metadata);
  return { ...(isJsonObject(output) ? output : {}), answers };
}

export function registerAskUserTool(registry: RuntimeToolRegistry): void {
  registry.register(
    defineTool({
      id: "ask.user",
      description:
        "Ask the user a structured question in this conversation and wait for their answers before continuing. Use for missing facts, choices, or confirmation the tools cannot infer.",
      permission: "assistant.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(
        z
          .object({
            question: z.string().trim().min(1).max(1_000),
            fields: z.array(fieldSchema).max(8).optional(),
          })
          .strict(),
        {
          type: "object",
          properties: {
            question: { type: "string", minLength: 1, maxLength: 1_000 },
            fields: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  label: { type: "string" },
                  type: { type: "string", enum: ["text", "select", "boolean"] },
                  options: { type: "array", items: { type: "string" } },
                },
                required: ["id", "label"],
                additionalProperties: false,
              },
            },
          },
          required: ["question"],
          additionalProperties: false,
        },
      ),
      outputSchema: zodToolSchema(z.unknown(), { type: "object", additionalProperties: true }),
      handler: async (input) => ({
        question: input.question,
        fields: input.fields ?? [],
      }),
    }),
  );
}
