import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolErrorEnvelope } from "../api/error-envelope.js";
import { toolInputFailure } from "./tool-input-issues.js";
import { createToolRegistry } from "./tool-registry.js";

const actor: Actor = {
  id: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000002",
  type: "user",
  scopes: ["platform.read"],
};

const sendSchema = z.object({
  to: z.array(z.string().email()).min(1),
  subject: z.string().min(1),
});

describe("tool input validation details (CA11)", () => {
  it("returns details.issues and a message naming the first failing field", async () => {
    const registry = createToolRegistry();
    registry.register({
      id: "demo.send",
      description: "Send a demo message.",
      permission: "platform.read",
      sideEffects: "read",
      inputSchema: {
        parse: (value: unknown) => sendSchema.parse(value),
        toJsonSchema: () => ({ type: "object" }),
      },
      outputSchema: { parse: (value: unknown) => value, toJsonSchema: () => ({}) },
      handler: async () => ({ sent: true }),
    });

    const result = await registry.invoke("demo.send", { to: ["not-an-email"] }, { actor });

    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      error: "Invalid input for demo.send: to.0: Invalid email (and 1 more issue)",
      details: {
        issues: [
          { path: ["to", 0], message: "Invalid email" },
          { path: ["subject"], message: "Required" },
        ],
      },
    });
    if (result.ok) throw new Error("expected a validation failure");
    expect(result.error).not.toContain("[");
    expect(toolErrorEnvelope(result, "trace-1").error).toMatchObject({
      code: "bad_request",
      details: { issues: [{ path: ["to", 0] }, { path: ["subject"] }] },
    });
  });

  it("keeps the original message for errors without issues", () => {
    expect(toolInputFailure("demo.send", new Error("invalid shape"))).toEqual({
      message: "invalid shape",
    });
    expect(
      toolInputFailure("demo.send", { issues: [{ path: [], message: "Expected object" }] }),
    ).toEqual({
      message: "Invalid input for demo.send: input: Expected object",
      details: { issues: [{ path: [], message: "Expected object" }] },
    });
  });
});
