import { describe, expect, it } from "vitest";
import { z, type ZodTypeAny } from "zod";
import { createChatToolDefinitions } from "../chat/tools.js";
import { createDriveToolDefinitions } from "../drive/tools.js";
import { createMailToolDefinitions } from "../mail/tools.js";
import { isGenericObjectPlaceholder, zodToolSchema } from "./tool-schemas.js";
import { zodToJsonSchema } from "./zod-json-schema.js";

const placeholder = { type: "object", additionalProperties: true } as const;

describe("zodToJsonSchema", () => {
  it("converts objects with required, optional, default, and strict keys", () => {
    const schema = z
      .object({
        name: z.string().min(1).max(10).describe("Display name"),
        email: z.string().email().optional(),
        limit: z.number().int().min(1).max(50).default(25),
      })
      .strict();

    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 10, description: "Display name" },
        email: { type: "string", format: "email" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 25 },
      },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("describes passthrough, catchall, and record objects", () => {
    expect(zodToJsonSchema(z.object({ a: z.boolean() }).passthrough())).toMatchObject({
      additionalProperties: true,
    });
    expect(zodToJsonSchema(z.object({}).catchall(z.number()))).toMatchObject({
      additionalProperties: { type: "number" },
    });
    expect(zodToJsonSchema(z.record(z.enum(["x", "y"]), z.string()))).toEqual({
      type: "object",
      additionalProperties: { type: "string" },
      propertyNames: { enum: ["x", "y"] },
    });
    expect(zodToJsonSchema(z.object({ a: z.string() }))).not.toHaveProperty("additionalProperties");
  });

  it("maps string formats, regex, and numeric bounds", () => {
    expect(zodToJsonSchema(z.string().uuid())).toEqual({ type: "string", format: "uuid" });
    expect(zodToJsonSchema(z.string().url())).toEqual({ type: "string", format: "uri" });
    expect(zodToJsonSchema(z.string().datetime())).toEqual({
      type: "string",
      format: "date-time",
    });
    expect(zodToJsonSchema(z.string().regex(/^[a-z]+$/u))).toEqual({
      type: "string",
      pattern: "^[a-z]+$",
    });
    expect(zodToJsonSchema(z.number().positive().lt(5))).toEqual({
      type: "number",
      exclusiveMinimum: 0,
      exclusiveMaximum: 5,
    });
  });

  it("maps enums, native enums, literals, and literal unions", () => {
    enum Color {
      Red = "red",
      Blue = "blue",
    }
    enum Level {
      Low,
      High,
    }
    expect(zodToJsonSchema(z.enum(["a", "b"]))).toEqual({ type: "string", enum: ["a", "b"] });
    expect(zodToJsonSchema(z.nativeEnum(Color))).toEqual({
      type: "string",
      enum: ["red", "blue"],
    });
    expect(zodToJsonSchema(z.nativeEnum(Level))).toEqual({ type: "number", enum: [0, 1] });
    expect(zodToJsonSchema(z.literal("folder"))).toEqual({ type: "string", const: "folder" });
    expect(zodToJsonSchema(z.union([z.literal("a"), z.literal("b")]))).toEqual({
      type: "string",
      enum: ["a", "b"],
    });
  });

  it("maps arrays, tuples, sets, nullable, unions, and intersections", () => {
    expect(zodToJsonSchema(z.array(z.string()).min(1).max(3))).toEqual({
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 3,
    });
    expect(zodToJsonSchema(z.tuple([z.string(), z.number()]))).toEqual({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      minItems: 2,
      items: false,
      maxItems: 2,
    });
    expect(zodToJsonSchema(z.set(z.string()))).toMatchObject({ uniqueItems: true });
    expect(zodToJsonSchema(z.string().nullable())).toEqual({ type: ["string", "null"] });
    expect(zodToJsonSchema(z.enum(["a"]).nullable())).toEqual({
      type: ["string", "null"],
      enum: ["a", null],
    });
    expect(zodToJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
    expect(
      zodToJsonSchema(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("a"), a: z.string() }),
          z.object({ kind: z.literal("b") }),
        ]),
      ),
    ).toMatchObject({ oneOf: [{ required: ["kind", "a"] }, { required: ["kind"] }] });
    expect(
      zodToJsonSchema(z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() }))),
    ).toMatchObject({ allOf: [{ required: ["a"] }, { required: ["b"] }] });
  });

  it("describes the input side of effects, pipelines, brands, catch, and dates", () => {
    const transformed = z.object({
      trimmed: z.string().trim().min(1),
      refined: z.string().refine((value) => value.length > 0),
      parsed: z.string().transform((value) => Number(value)),
      pre: z.preprocess((value) => value, z.number().int()),
      piped: z.string().pipe(z.coerce.number()),
      branded: z.string().uuid().brand<"Id">(),
      fallback: z.string().catch("x"),
      at: z.date(),
      anything: z.unknown(),
    });
    const json = zodToJsonSchema(transformed);
    expect(json.properties).toEqual({
      trimmed: { type: "string", minLength: 1 },
      refined: { type: "string" },
      parsed: { type: "string" },
      pre: { type: "integer" },
      piped: { type: "string" },
      branded: { type: "string", format: "uuid" },
      fallback: { type: "string" },
      at: { type: "string", format: "date-time" },
      anything: {},
    });
    expect(json.required).toEqual([
      "trimmed",
      "refined",
      "parsed",
      "pre",
      "piped",
      "branded",
      "at",
    ]);
    expect(zodToJsonSchema(z.string().transform(Number), { io: "output" })).toEqual({});
  });

  it("bounds recursive lazy schemas instead of looping", () => {
    interface Node {
      readonly name: string;
      readonly children: Node[];
    }
    const node: z.ZodType<Node> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(node) }),
    );
    const json = zodToJsonSchema(node);
    expect(json).toMatchObject({
      type: "object",
      properties: { name: { type: "string" }, children: { type: "array", items: {} } },
    });
  });

  it("falls back to {} for unknown constructs instead of throwing", () => {
    expect(zodToJsonSchema(z.map(z.string(), z.string()))).toEqual({});
    expect(zodToJsonSchema(z.any())).toEqual({});
    expect(zodToJsonSchema({ _def: { typeName: "ZodFuture" } } as unknown as ZodTypeAny)).toEqual(
      {},
    );
  });
});

describe("zodToolSchema", () => {
  it("replaces the generic placeholder but keeps explicit schemas", () => {
    const schema = z.object({ id: z.string() });
    expect(zodToolSchema(schema, placeholder).toJsonSchema()).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    const explicit = { type: "object", properties: { custom: { type: "string" } } } as const;
    expect(zodToolSchema(schema, explicit).toJsonSchema()).toBe(explicit);
    expect(zodToolSchema(z.unknown(), placeholder).toJsonSchema()).toEqual(placeholder);
    expect(isGenericObjectPlaceholder({ ...placeholder, description: "x" })).toBe(false);
  });

  it("publishes real fields for mail.send, drive.list, and chat.send", () => {
    const tools = [
      ...createMailToolDefinitions({ store: {} as never }),
      ...createDriveToolDefinitions({ store: {} as never }),
      ...createChatToolDefinitions({ store: {} as never }),
    ];
    const inputSchema = (id: string) => {
      const tool = tools.find((candidate) => candidate.id === id);
      if (tool === undefined) throw new Error(`Missing tool ${id}`);
      return tool.inputSchema.toJsonSchema() as {
        readonly type?: unknown;
        readonly properties?: Record<string, unknown>;
        readonly required?: readonly string[];
      };
    };

    const send = inputSchema("mail.send");
    expect(send.type).toBe("object");
    expect(Object.keys(send.properties ?? {})).toEqual(
      expect.arrayContaining(["to", "cc", "subject", "bodyText", "attachments"]),
    );
    expect(send.required).toEqual(expect.arrayContaining(["to", "subject", "bodyText"]));
    expect(send.required).not.toContain("cc");
    expect(send.required).not.toContain("attachments");

    const list = inputSchema("drive.list");
    expect(Object.keys(list.properties ?? {})).toEqual(
      expect.arrayContaining(["folderId", "limit", "cursor"]),
    );
    expect(list.required ?? []).not.toContain("limit");

    const chat = inputSchema("chat.send");
    expect(chat.properties).toHaveProperty("roomId", { type: "string", format: "uuid" });
    expect(chat.required).toEqual(expect.arrayContaining(["roomId", "body"]));

    for (const tool of tools) {
      expect(tool.inputSchema.toJsonSchema().type, tool.id).toBe("object");
    }
  });
});
