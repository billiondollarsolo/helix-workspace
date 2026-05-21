import { describe, expect, it } from "vitest";
import { createEventSchemaRegistry } from "./schema-registry.js";

const payloadSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    configKey: { type: "string" },
  },
  required: ["configKey"],
} as const;

describe("EventSchemaRegistry", () => {
  it("registers event schemas by id and subject in sorted subject order", () => {
    const registry = createEventSchemaRegistry([
      {
        id: "platform.config.changed",
        subject: "platform.config.changed",
        payloadSchema,
      },
      {
        id: "platform.audit.recorded",
        subject: "platform.audit.recorded",
        payloadSchema,
      },
    ]);

    expect(registry.get("platform.config.changed")?.subject).toBe("platform.config.changed");
    expect(registry.getBySubject("platform.audit.recorded")?.id).toBe("platform.audit.recorded");
    expect(registry.list().map((event) => event.subject)).toEqual([
      "platform.audit.recorded",
      "platform.config.changed",
    ]);
  });

  it("normalizes identifiers and rejects duplicate subjects", () => {
    const registry = createEventSchemaRegistry();

    registry.register({
      id: " platform.config.changed ",
      subject: " platform.config.changed ",
      payloadSchema,
    });

    expect(registry.get("platform.config.changed")).toBeDefined();
    expect(() => {
      registry.register({
        id: "platform.config.updated",
        subject: "platform.config.changed",
        payloadSchema,
      });
    }).toThrow("Event subject already registered: platform.config.changed");
  });
});
