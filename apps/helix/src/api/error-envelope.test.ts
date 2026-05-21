import { describe, expect, it } from "vitest";
import { buildErrorEnvelope, errorCodeForStatus, toolErrorEnvelope } from "./error-envelope.js";
import type { ToolInvokeErrorResult, ToolRateLimitMetadata } from "../platform/tool-registry.js";

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

describe("error-envelope", () => {
  it("maps status codes to stable error codes", () => {
    expect(errorCodeForStatus(400)).toBe("bad_request");
    expect(errorCodeForStatus(403)).toBe("forbidden");
    expect(errorCodeForStatus(429)).toBe("rate_limited");
    expect(errorCodeForStatus(418)).toBe("error");
  });

  it("builds the canonical envelope with a traceId", () => {
    expect(
      buildErrorEnvelope({ statusCode: 404, message: "missing", traceId: "trace-1" }),
    ).toEqual({
      error: { code: "not_found", message: "missing", traceId: "trace-1" },
    });
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
});
