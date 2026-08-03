import { describe, expect, it } from "vitest";
import type { Actor, ToolDefinition } from "@helix/sdk-types";
import { buildErrorEnvelope, errorCodeForStatus, toolErrorEnvelope } from "./error-envelope.js";
import {
  createToolRegistry,
  type ToolInvokeErrorResult,
  type ToolRateLimitMetadata,
} from "../platform/tool-registry.js";
import { RuntimeAgentOperationalControlStore } from "../platform/tools/agent-operational-controls.js";

const rateLimitMetadata: ToolRateLimitMetadata = {
  reason: "requests_per_minute",
  retryAfterSeconds: 7,
  usage: {
    requestsPerMinute: { limit: 1, used: 1, remaining: 0, resetsAt: null },
    requestsPerDay: { limit: 10, used: 1, remaining: 9, resetsAt: null },
    costPerDay: {
      limitUsdMicros: null,
      usedUsdMicros: 0,
      remainingUsdMicros: null,
      resetsAt: "2026-05-21T00:00:00.000Z",
      warningThresholdUsdMicros: null,
      warningReached: false,
    },
  },
};

const writeActor: Actor = {
  id: "actor-write-1",
  orgId: "org-a",
  type: "user",
  scopes: ["danger.write"],
};

const passthroughSchema = {
  parse: (value: unknown) => value,
  toJsonSchema: () => ({ type: "object", additionalProperties: true }),
};

function writeTool(id: string): ToolDefinition {
  return {
    id,
    description: id,
    permission: "danger.write",
    sideEffects: "write",
    inputSchema: passthroughSchema,
    outputSchema: passthroughSchema,
    handler: async () => ({ written: true }),
  };
}

describe("error-envelope", () => {
  it("maps status codes to stable error codes", () => {
    expect(errorCodeForStatus(400)).toBe("bad_request");
    expect(errorCodeForStatus(403)).toBe("forbidden");
    expect(errorCodeForStatus(410)).toBe("gone");
    expect(errorCodeForStatus(429)).toBe("rate_limited");
    expect(errorCodeForStatus(418)).toBe("error");
    // 503 has no dedicated ERROR_CODES entry; mapper stays on legacy fallback.
    expect(errorCodeForStatus(503)).toBe("error");
  });

  it("builds the canonical envelope with a traceId", () => {
    expect(buildErrorEnvelope({ statusCode: 404, message: "missing", traceId: "trace-1" })).toEqual(
      {
        error: { code: "not_found", message: "missing", traceId: "trace-1" },
      },
    );
  });

  it("includes rate-limit details for failed tool results", () => {
    const result: ToolInvokeErrorResult = {
      ok: false,
      statusCode: 429,
      error: "limit exceeded",
      retryAfterSeconds: 7,
      rateLimit: rateLimitMetadata,
    };

    expect(toolErrorEnvelope(result, "trace-2")).toEqual({
      error: {
        code: "rate_limited",
        message: "limit exceeded",
        traceId: "trace-2",
        details: {
          retryAfterSeconds: 7,
          rateLimit: result.rateLimit,
        },
      },
    });
  });

  it("maps agent operational kill denial to 503 + stable envelope (E9.2)", async () => {
    const store = new RuntimeAgentOperationalControlStore();
    store.setSnapshot({ globalReadOnly: true });
    const registry = createToolRegistry({ operationalControls: store });
    registry.register(writeTool("mail.send"));

    const denied = await registry.invoke("mail.send", {}, { actor: writeActor });
    expect(denied.ok).toBe(false);
    if (denied.ok) {
      throw new Error("expected operational kill denial");
    }

    expect(denied.statusCode).toBe(503);
    expect(denied.error).toBe("Tool mutations are temporarily disabled by global read-only mode.");

    const envelope = toolErrorEnvelope(denied, "trace-kill-1");
    expect(envelope).toEqual({
      error: {
        code: "error",
        message: "Tool mutations are temporarily disabled by global read-only mode.",
        traceId: "trace-kill-1",
      },
    });
    expect(errorCodeForStatus(denied.statusCode)).toBe(envelope.error.code);
  });
});
