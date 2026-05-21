import { z, type ZodTypeAny } from "zod";
import type { JsonObject } from "@helix/sdk-types";

/**
 * Converts the JSON Schema produced by a tool's {@link SchemaAdapter} into a
 * Zod schema, so the per-tool tRPC projection (P1-3) can attach real
 * `.input()`/`.output()` validators derived from the single tool registry.
 *
 * This intentionally supports the JSON Schema subset Helix tool schemas use
 * (objects, arrays, primitives, enums, unions). Unrecognised constructs fall
 * back to `z.unknown()` so projection never fails closed on an exotic schema.
 */
export function jsonSchemaToZod(schema: JsonObject): ZodTypeAny {
  return convert(schema);
}

function convert(schema: JsonObject): ZodTypeAny {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return enumSchema(schema.enum);
  }
  if (Array.isArray(schema.anyOf)) {
    return unionSchema(schema.anyOf);
  }
  if (Array.isArray(schema.oneOf)) {
    return unionSchema(schema.oneOf);
  }

  const type = schemaType(schema);
  switch (type) {
    case "object":
      return objectSchema(schema);
    case "array":
      return arraySchema(schema);
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    default:
      // No `type` keyword (e.g. `{}` "any") — accept anything.
      return z.unknown();
  }
}

function schemaType(schema: JsonObject): string | undefined {
  const rawType = schema.type;
  if (typeof rawType === "string") {
    return rawType;
  }
  if (Array.isArray(rawType) && typeof rawType[0] === "string") {
    return rawType[0];
  }
  return undefined;
}

function objectSchema(schema: JsonObject): ZodTypeAny {
  const propertiesValue = schema.properties;
  const properties =
    typeof propertiesValue === "object" && propertiesValue !== null && !Array.isArray(propertiesValue)
      ? (propertiesValue as Record<string, unknown>)
      : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [],
  );

  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      shape[key] = z.unknown();
      continue;
    }
    const child = convert(value as JsonObject);
    shape[key] = required.has(key) ? child : child.optional();
  }

  const object = z.object(shape);
  return schema.additionalProperties === false ? object.strict() : object.passthrough();
}

function arraySchema(schema: JsonObject): ZodTypeAny {
  const items = schema.items;
  if (typeof items === "object" && items !== null && !Array.isArray(items)) {
    return z.array(convert(items as JsonObject));
  }
  return z.array(z.unknown());
}

function enumSchema(values: readonly unknown[]): ZodTypeAny {
  const stringValues = values.filter((value): value is string => typeof value === "string");
  if (stringValues.length === values.length && stringValues.length > 0) {
    return z.enum(stringValues as [string, ...string[]]);
  }
  const literals: ZodTypeAny[] = values.map((value) =>
    z.literal(value as string | number | boolean),
  );
  if (literals.length >= 2) {
    return z.union(literals as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }
  return literals[0] ?? z.unknown();
}

function unionSchema(schemas: readonly unknown[]): ZodTypeAny {
  const converted = schemas
    .filter(
      (entry): entry is JsonObject =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    )
    .map((entry) => convert(entry));
  if (converted.length >= 2) {
    return z.union(converted as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }
  return converted[0] ?? z.unknown();
}
