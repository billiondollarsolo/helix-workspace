import { z } from "zod";
import { BadRequestError } from "../../api/api-error.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import type { AssistantSource } from "./types.js";

const defaultLimit = 2_000;
const maxLimit = 4_000;

export interface ContextPage {
  readonly sourceId: string;
  readonly title?: string;
  readonly type: string;
  readonly content: string;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly totalChars: number;
}

export interface ContextMatch {
  readonly sourceId: string;
  readonly title?: string;
  readonly line: number;
  readonly text: string;
}

export function pageSource(
  sources: readonly AssistantSource[],
  sourceId: string,
  offset = 0,
  limit = defaultLimit,
): ContextPage {
  const source = sources.find(
    (entry) => entry.id === sourceId || entry.provenance.sourceId === sourceId,
  );
  if (source === undefined || typeof source.body !== "string" || source.body.length === 0)
    throw new BadRequestError(
      "That source is not in the current turn context. Attach the file or fetch the page again.",
    );
  const size = Math.min(Math.max(limit, 1), maxLimit);
  const start = Math.max(0, offset);
  const content = source.body.slice(start, start + size);
  return {
    sourceId: source.id,
    type: source.type,
    content,
    offset: start,
    nextOffset: start + content.length < source.body.length ? start + content.length : null,
    totalChars: source.body.length,
    ...(source.title === undefined ? {} : { title: source.title }),
  };
}

export function grepSources(
  sources: readonly AssistantSource[],
  pattern: string,
  sourceId?: string,
): readonly ContextMatch[] {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "iu");
  } catch {
    throw new BadRequestError("Enter a valid regular expression.");
  }
  const matches: ContextMatch[] = [];
  for (const source of sources) {
    if (sourceId !== undefined && source.id !== sourceId && source.provenance.sourceId !== sourceId)
      continue;
    if (typeof source.body !== "string") continue;
    for (const [index, line] of source.body.split("\n").entries()) {
      if (!regex.test(line)) continue;
      matches.push({
        sourceId: source.id,
        line: index + 1,
        text: line.slice(0, 400),
        ...(source.title === undefined ? {} : { title: source.title }),
      });
      if (matches.length >= 50) return matches;
    }
  }
  return matches;
}

export function registerContextTools(registry: RuntimeToolRegistry): void {
  registry.register(
    defineTool({
      id: "context.view",
      description:
        "Read a bounded slice of a file or retrieved source attached to this Assistant turn. Use nextOffset to continue.",
      permission: "assistant.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(
        z
          .object({
            sourceId: z.string().min(1).max(200),
            offset: z.number().int().min(0).max(1_048_576).default(0),
            limit: z.number().int().min(1).max(maxLimit).default(defaultLimit),
          })
          .strict(),
        {
          type: "object",
          properties: {
            sourceId: { type: "string" },
            offset: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: maxLimit },
          },
          required: ["sourceId"],
          additionalProperties: false,
        },
      ),
      outputSchema: zodToolSchema(z.unknown(), { type: "object", additionalProperties: true }),
      handler: async () => {
        throw new BadRequestError("context.view is only available inside Assistant.");
      },
    }),
  );
  registry.register(
    defineTool({
      id: "context.grep",
      description:
        "Search current-turn attachments and retrieved sources with a regular expression.",
      permission: "assistant.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(
        z
          .object({
            pattern: z.string().min(1).max(200),
            sourceId: z.string().min(1).max(200).optional(),
          })
          .strict(),
        {
          type: "object",
          properties: {
            pattern: { type: "string" },
            sourceId: { type: "string" },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
      ),
      outputSchema: zodToolSchema(z.unknown(), { type: "object", additionalProperties: true }),
      handler: async () => {
        throw new BadRequestError("context.grep is only available inside Assistant.");
      },
    }),
  );
}
