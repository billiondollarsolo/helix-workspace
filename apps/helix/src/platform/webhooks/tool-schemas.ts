import type { JsonObject, SchemaAdapter } from "@helix/sdk-types";
import { z, type ZodTypeAny } from "zod3";

export function zodToolSchema<TSchema extends ZodTypeAny>(
  schema: TSchema,
  jsonSchema: JsonObject,
): SchemaAdapter<z.output<TSchema>> {
  return {
    parse(value) {
      return schema.parse(value) as z.output<TSchema>;
    },
    toJsonSchema() {
      return jsonSchema;
    },
  };
}

export const stringRecordSchema = z.record(z.string());

export const jsonRecordSchema = z.record(z.unknown());
