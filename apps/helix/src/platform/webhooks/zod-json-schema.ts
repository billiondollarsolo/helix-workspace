import { isJsonValue, type JsonObject, type JsonValue } from "@helix/sdk-types";
import type { ZodTypeAny } from "zod";

/**
 * In-repo converter from zod v3 schemas to a JSON Schema (draft 2020-12)
 * subset, used to publish real tool input/output schemas on MCP `tools/list`,
 * `/openapi.json`, `/api/tools`, and `helix tool describe` (MC1 / CA5).
 *
 * The converter reads zod's public `_def` structure. Unknown or exotic
 * constructs fall back to `{}` (any value) instead of throwing, so one odd
 * schema never breaks the whole tool catalogue.
 *
 * `io: "input"` (the default) describes what a caller must SEND: transforms and
 * preprocessors are described by their input schema, `.default()` fields are
 * optional, and pipelines use their `in` side. `io: "output"` describes the
 * parsed value instead.
 */
export interface ZodJsonSchemaOptions {
  readonly io?: "input" | "output";
  /** Nesting bound for recursive (`z.lazy`) schemas; deeper levels become `{}`. */
  readonly maxDepth?: number;
}

type ZodDef = Record<string, unknown> & { readonly typeName?: string };

interface ConvertState {
  readonly io: "input" | "output";
  readonly maxDepth: number;
  readonly active: Set<unknown>;
}

const DEFAULT_MAX_DEPTH = 32;

export function zodToJsonSchema(
  schema: ZodTypeAny,
  options: ZodJsonSchemaOptions = {},
): JsonObject {
  return convert(schema, {
    io: options.io ?? "input",
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    active: new Set(),
  });
}

function defOf(schema: unknown): ZodDef | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const def = (schema as { readonly _def?: unknown })._def;
  return typeof def === "object" && def !== null ? (def as ZodDef) : undefined;
}

function convert(schema: unknown, state: ConvertState): JsonObject {
  const def = defOf(schema);
  if (def === undefined) return {};
  // Recursion guard: a schema already being converted higher up the stack
  // (only possible through z.lazy) or an excessive depth degrades to `{}`.
  if (state.active.has(schema) || state.active.size >= state.maxDepth) return {};
  state.active.add(schema);
  try {
    const converted = convertDef(def, state);
    const description = (schema as { readonly description?: unknown }).description;
    return typeof description === "string" && description.length > 0
      ? { ...converted, description }
      : converted;
  } catch {
    return {};
  } finally {
    state.active.delete(schema);
  }
}

function convertDef(def: ZodDef, state: ConvertState): JsonObject {
  switch (def.typeName) {
    case "ZodString":
      return stringSchema(def);
    case "ZodNumber":
      return numberSchema(def);
    case "ZodBigInt":
      return { type: "integer" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodDate":
      return { type: "string", format: "date-time" };
    case "ZodNull":
      return { type: "null" };
    case "ZodNever":
      return { not: {} };
    case "ZodLiteral":
      return literalSchema(def.value);
    case "ZodEnum":
      return enumSchema(Array.isArray(def.values) ? (def.values as unknown[]) : []);
    case "ZodNativeEnum":
      return enumSchema(nativeEnumValues(def.values));
    case "ZodObject":
      return objectSchema(def, state);
    case "ZodArray":
      return arraySchema(def, state);
    case "ZodSet":
      return setSchema(def, state);
    case "ZodTuple":
      return tupleSchema(def, state);
    case "ZodRecord":
      return recordSchema(def, state);
    case "ZodUnion":
      return unionSchema(asArray(def.options), state, "anyOf");
    case "ZodDiscriminatedUnion":
      return unionSchema(discriminatedOptions(def.options), state, "oneOf");
    case "ZodIntersection":
      return { allOf: [convert(def.left, state), convert(def.right, state)] };
    case "ZodOptional":
      return convert(def.innerType, state);
    case "ZodNullable":
      return nullable(convert(def.innerType, state));
    case "ZodDefault":
      return withDefault(convert(def.innerType, state), def.defaultValue);
    case "ZodCatch":
    case "ZodReadonly":
      return convert(def.innerType, state);
    case "ZodBranded":
      return convert(def.type, state);
    case "ZodLazy":
      return typeof def.getter === "function"
        ? convert((def.getter as () => unknown)(), state)
        : {};
    case "ZodEffects":
      return effectsSchema(def, state);
    case "ZodPipeline":
      return convert(state.io === "input" ? def.in : def.out, state);
    default:
      // ZodAny, ZodUnknown, ZodUndefined, ZodVoid, ZodNaN, ZodMap, ZodPromise,
      // ZodFunction, ZodSymbol and anything newer: accept any JSON value.
      return {};
  }
}

function stringSchema(def: ZodDef): JsonObject {
  const result: Record<string, JsonValue> = { type: "string" };
  for (const check of asArray(def.checks)) {
    if (typeof check !== "object" || check === null) continue;
    const entry = check as Record<string, unknown>;
    const value = typeof entry.value === "number" ? entry.value : undefined;
    switch (entry.kind) {
      case "min":
        if (value !== undefined) result.minLength = maxOf(result.minLength, value);
        break;
      case "max":
        if (value !== undefined) result.maxLength = minOf(result.maxLength, value);
        break;
      case "length":
        if (value !== undefined) {
          result.minLength = value;
          result.maxLength = value;
        }
        break;
      case "email":
        result.format = "email";
        break;
      case "url":
        result.format = "uri";
        break;
      case "uuid":
        result.format = "uuid";
        break;
      case "datetime":
        result.format = "date-time";
        break;
      case "date":
        result.format = "date";
        break;
      case "time":
        result.format = "time";
        break;
      case "duration":
        result.format = "duration";
        break;
      case "ip":
        result.format = entry.version === "v6" ? "ipv6" : "ipv4";
        break;
      case "regex":
        if (entry.regex instanceof RegExp && result.pattern === undefined) {
          result.pattern = entry.regex.source;
        }
        break;
      case "startsWith":
        if (typeof entry.value === "string" && result.pattern === undefined) {
          result.pattern = `^${escapeRegExp(entry.value)}`;
        }
        break;
      case "endsWith":
        if (typeof entry.value === "string" && result.pattern === undefined) {
          result.pattern = `${escapeRegExp(entry.value)}$`;
        }
        break;
      default:
        break;
    }
  }
  return result;
}

function numberSchema(def: ZodDef): JsonObject {
  const result: Record<string, JsonValue> = { type: "number" };
  for (const check of asArray(def.checks)) {
    if (typeof check !== "object" || check === null) continue;
    const entry = check as Record<string, unknown>;
    const value = typeof entry.value === "number" ? entry.value : undefined;
    switch (entry.kind) {
      case "int":
        result.type = "integer";
        break;
      case "min":
        if (value !== undefined) {
          if (entry.inclusive === false) result.exclusiveMinimum = value;
          else result.minimum = value;
        }
        break;
      case "max":
        if (value !== undefined) {
          if (entry.inclusive === false) result.exclusiveMaximum = value;
          else result.maximum = value;
        }
        break;
      case "multipleOf":
        if (value !== undefined) result.multipleOf = value;
        break;
      default:
        break;
    }
  }
  return result;
}

function literalSchema(value: unknown): JsonObject {
  if (value === null) return { type: "null", const: null };
  if (typeof value === "string") return { type: "string", const: value };
  if (typeof value === "boolean") return { type: "boolean", const: value };
  if (typeof value === "number") {
    return { type: Number.isInteger(value) ? "integer" : "number", const: value };
  }
  return {};
}

function enumSchema(values: readonly unknown[]): JsonObject {
  const jsonValues = values.filter(
    (value): value is string | number => typeof value === "string" || typeof value === "number",
  );
  if (jsonValues.length === 0) return {};
  const types = new Set(jsonValues.map((value) => typeof value));
  if (types.size === 1) {
    return { type: types.has("string") ? "string" : "number", enum: jsonValues };
  }
  return { enum: jsonValues };
}

function nativeEnumValues(values: unknown): unknown[] {
  if (typeof values !== "object" || values === null) return [];
  const record = values as Record<string, unknown>;
  // Numeric TypeScript enums carry reverse mappings (`{ A: 0, "0": "A" }`).
  return Object.keys(record)
    .filter((key) => typeof record[record[key] as string] !== "number")
    .map((key) => record[key]);
}

function objectSchema(def: ZodDef, state: ConvertState): JsonObject {
  const shape = typeof def.shape === "function" ? (def.shape as () => unknown)() : def.shape;
  const properties: Record<string, JsonValue> = {};
  const required: string[] = [];
  if (typeof shape === "object" && shape !== null) {
    for (const [key, value] of Object.entries(shape as Record<string, unknown>)) {
      properties[key] = convert(value, state);
      if (!isOptionalField(value, state.io)) required.push(key);
    }
  }
  const result: Record<string, JsonValue> = { type: "object", properties };
  if (required.length > 0) result.required = required;

  const catchallDef = defOf(def.catchall);
  if (catchallDef !== undefined && catchallDef.typeName !== "ZodNever") {
    result.additionalProperties = convert(def.catchall, state);
  } else if (def.unknownKeys === "strict") {
    result.additionalProperties = false;
  } else if (def.unknownKeys === "passthrough") {
    result.additionalProperties = true;
  }
  // `strip` (zod's default) accepts and drops unknown keys; JSON Schema's
  // default (no `additionalProperties`) is the faithful description.
  return result;
}

/**
 * Whether an object field may be omitted. Structural (never calls `parse`) so
 * user transforms are not executed while building documentation.
 */
function isOptionalField(schema: unknown, io: "input" | "output", depth = 0): boolean {
  const def = defOf(schema);
  if (def === undefined || depth > 16) return false;
  switch (def.typeName) {
    case "ZodOptional":
    case "ZodUndefined":
    case "ZodVoid":
    case "ZodAny":
    case "ZodUnknown":
      return true;
    case "ZodDefault":
    case "ZodCatch":
      return io === "input" || isOptionalField(def.innerType, io, depth + 1);
    case "ZodNullable":
    case "ZodReadonly":
      return isOptionalField(def.innerType, io, depth + 1);
    case "ZodBranded":
      return isOptionalField(def.type, io, depth + 1);
    case "ZodEffects":
      return io === "input" ? isOptionalField(def.schema, io, depth + 1) : false;
    case "ZodPipeline":
      return isOptionalField(io === "input" ? def.in : def.out, io, depth + 1);
    case "ZodLazy":
      return typeof def.getter === "function"
        ? isOptionalField((def.getter as () => unknown)(), io, depth + 1)
        : false;
    case "ZodUnion":
      return asArray(def.options).some((option) => isOptionalField(option, io, depth + 1));
    default:
      return false;
  }
}

function arraySchema(def: ZodDef, state: ConvertState): JsonObject {
  const result: Record<string, JsonValue> = { type: "array", items: convert(def.type, state) };
  const exact = lengthValue(def.exactLength);
  const min = lengthValue(def.minLength);
  const max = lengthValue(def.maxLength);
  if (exact !== undefined) {
    result.minItems = exact;
    result.maxItems = exact;
  }
  if (min !== undefined) result.minItems = min;
  if (max !== undefined) result.maxItems = max;
  return result;
}

function setSchema(def: ZodDef, state: ConvertState): JsonObject {
  const result: Record<string, JsonValue> = {
    type: "array",
    uniqueItems: true,
    items: convert(def.valueType, state),
  };
  const min = lengthValue(def.minSize);
  const max = lengthValue(def.maxSize);
  if (min !== undefined) result.minItems = min;
  if (max !== undefined) result.maxItems = max;
  return result;
}

function tupleSchema(def: ZodDef, state: ConvertState): JsonObject {
  const items = asArray(def.items).map((item) => convert(item, state));
  const result: Record<string, JsonValue> = {
    type: "array",
    prefixItems: items,
    minItems: items.length,
  };
  if (defOf(def.rest) === undefined) {
    result.items = false;
    result.maxItems = items.length;
  } else {
    result.items = convert(def.rest, state);
  }
  return result;
}

function recordSchema(def: ZodDef, state: ConvertState): JsonObject {
  const result: Record<string, JsonValue> = {
    type: "object",
    additionalProperties: convert(def.valueType, state),
  };
  const keyConstraints = Object.fromEntries(
    Object.entries(convert(def.keyType, state)).filter(([key]) => key !== "type"),
  );
  if (Object.keys(keyConstraints).length > 0) result.propertyNames = keyConstraints;
  return result;
}

function unionSchema(
  options: readonly unknown[],
  state: ConvertState,
  keyword: "anyOf" | "oneOf",
): JsonObject {
  const converted = options.map((option) => convert(option, state));
  if (converted.length === 0) return {};
  if (converted.length === 1) return converted[0] ?? {};
  // `z.union([z.literal("a"), z.literal("b")])` reads better as an enum.
  const consts = converted.map((entry) =>
    Object.keys(entry).every((key) => key === "const" || key === "type") ? entry.const : undefined,
  );
  const stringConsts = consts.filter((value): value is string => typeof value === "string");
  if (stringConsts.length === consts.length) {
    return { type: "string", enum: stringConsts };
  }
  return { [keyword]: converted };
}

function discriminatedOptions(options: unknown): unknown[] {
  if (Array.isArray(options)) return options;
  if (options instanceof Map) return [...options.values()];
  return [];
}

function effectsSchema(def: ZodDef, state: ConvertState): JsonObject {
  const effect = def.effect as { readonly type?: unknown } | undefined;
  if (state.io === "output" && effect?.type === "transform") {
    // The output of an arbitrary transform cannot be described statically.
    return {};
  }
  return convert(def.schema, state);
}

function nullable(inner: JsonObject): JsonObject {
  if (Object.keys(inner).length === 0) return inner;
  const type = inner.type;
  if (typeof type === "string") {
    const result: Record<string, JsonValue> = { ...inner, type: [type, "null"] };
    if (isJsonArray(inner.enum)) result.enum = [...inner.enum, null];
    if ("const" in inner) {
      delete result.const;
      result.enum = [inner.const ?? null, null];
    }
    return result;
  }
  if (isJsonArray(type)) {
    return type.includes("null") ? inner : { ...inner, type: [...type, "null"] };
  }
  return { anyOf: [inner, { type: "null" }] };
}

function withDefault(inner: JsonObject, defaultValue: unknown): JsonObject {
  if (typeof defaultValue !== "function") return inner;
  try {
    const value: unknown = (defaultValue as () => unknown)();
    return isJsonValue(value) ? { ...inner, default: value } : inner;
  } catch {
    return inner;
  }
}

function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function lengthValue(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = (value as { readonly value?: unknown }).value;
  return typeof raw === "number" ? raw : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function maxOf(current: JsonValue | undefined, value: number): number {
  return typeof current === "number" ? Math.max(current, value) : value;
}

function minOf(current: JsonValue | undefined, value: number): number {
  return typeof current === "number" ? Math.min(current, value) : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
