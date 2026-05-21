import type { ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { createScopedSearchRequest, globalSearchTypes } from "./scope.js";
import type { SearchEngine } from "./types.js";

const globalSearchTypeSchema = z.enum(globalSearchTypes);
const typesSchema = z.preprocess(
  (value) => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return undefined;
      }
      if (trimmed.startsWith("[")) {
        return JSON.parse(trimmed) as unknown;
      }
      return [trimmed];
    }
    return value;
  },
  z.array(globalSearchTypeSchema).max(globalSearchTypes.length).optional(),
);

const querySchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  types: typesSchema,
  limit: z.coerce.number().int().positive().max(50).default(10),
  offset: z.coerce.number().int().min(0).max(1_000).default(0),
});

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export interface CreateSearchToolDefinitionsOptions {
  readonly engine: SearchEngine;
}

export function createSearchToolDefinitions(
  options: CreateSearchToolDefinitionsOptions,
): readonly ToolDefinition[] {
  return [
    defineTool<z.output<typeof querySchema>, unknown>({
      id: "search.query",
      description:
        "Search across indexed mail, chat, docs, drive, and calendar records visible to the current actor.",
      permission: "platform.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(querySchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const request = createScopedSearchRequest(ctx.actor, input);
        if (request === undefined) {
          return { hits: [], query: input.query, estimatedTotalHits: 0 };
        }
        return options.engine.search(request);
      },
    }),
  ];
}

export function registerSearchTools(
  registry: RuntimeToolRegistry,
  options: CreateSearchToolDefinitionsOptions,
): void {
  for (const tool of createSearchToolDefinitions(options)) {
    registry.register(tool);
  }
}

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}
