import type { ToolDefinition } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { projectToolListItem } from "./tool-projection.js";

describe("projectToolListItem", () => {
  it("includes agent-facing rate-limit and cost metadata in runtime tool lists", () => {
    expect(
      projectToolListItem({
        id: "mail.send",
        description: "Send mail.",
        permission: "mail.send",
        sideEffects: "external_communication",
        confirmationRequired: true,
        rateLimit: { perActor: { perHour: 60, perDay: 200 } },
        estimatedCostUsdMicros: 1250,
        inputSchema: schema,
        outputSchema: schema,
        handler: async () => ({ ok: true }),
      } satisfies ToolDefinition),
    ).toEqual({
      id: "mail.send",
      description: "Send mail.",
      permission: "mail.send",
      sideEffects: "external_communication",
      confirmationRequired: true,
      rateLimit: { perActor: { perHour: 60, perDay: 200 } },
      estimatedCostUsdMicros: 1250,
    });
  });

  it("keeps optional metadata absent when a tool does not define it", () => {
    expect(
      projectToolListItem({
        id: "platform.ping",
        description: "Ping.",
        permission: "platform.read",
        sideEffects: "read",
        inputSchema: schema,
        outputSchema: schema,
        handler: async () => ({ ok: true }),
      } satisfies ToolDefinition),
    ).toEqual({
      id: "platform.ping",
      description: "Ping.",
      permission: "platform.read",
      sideEffects: "read",
      confirmationRequired: false,
    });
  });
});

const schema = {
  parse: (value: unknown) => value,
  toJsonSchema: () => ({ type: "object" }),
};
