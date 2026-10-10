import type { JsonObject, SchemaAdapter } from "@helix/sdk-types";
import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "./zod-json-schema.js";

/**
 * Wraps a zod schema as a tool {@link SchemaAdapter}.
 *
 * Most call sites pass the placeholder `{ type: "object", additionalProperties:
 * true }` as `jsonSchema`. That placeholder published no fields to MCP
 * `tools/list`, OpenAPI, or `helix tool describe` (MC1 / CA5), so it is now
 * replaced by a schema converted from the zod definition (input side). An
 * explicit, hand-written JSON Schema is still returned unchanged.
 */
export function zodToolSchema<TSchema extends ZodTypeAny>(
  schema: TSchema,
  jsonSchema: JsonObject,
): SchemaAdapter<z.output<TSchema>> {
  let published: JsonObject | undefined;
  return {
    parse(value) {
      return schema.parse(value) as z.output<TSchema>;
    },
    toJsonSchema() {
      published ??= isGenericObjectPlaceholder(jsonSchema)
        ? convertedOrPlaceholder(schema, jsonSchema)
        : jsonSchema;
      return published;
    },
  };
}

/** True for exactly `{ type: "object", additionalProperties: true }`. */
export function isGenericObjectPlaceholder(jsonSchema: JsonObject): boolean {
  const keys = Object.keys(jsonSchema);
  return (
    keys.length === 2 && jsonSchema.type === "object" && jsonSchema.additionalProperties === true
  );
}

function convertedOrPlaceholder(schema: ZodTypeAny, placeholder: JsonObject): JsonObject {
  const converted = zodToJsonSchema(schema);
  // `z.unknown()` and other opaque schemas convert to `{}`; keep the object
  // placeholder rather than publishing a less specific schema.
  return Object.keys(converted).length === 0 ? placeholder : converted;
}

export const stringRecordSchema = z.record(z.string(), z.string());

export const jsonRecordSchema = z.record(z.string(), z.unknown());
