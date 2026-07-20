import { describe, expect, it } from "vitest";
import {
  errorCodeForStatus,
  statusForErrorCode,
  errorEnvelopeSchema,
  ERROR_CODES,
} from "./errors.js";

describe("error codes", () => {
  it("maps statuses to stable codes", () => {
    expect(errorCodeForStatus(400)).toBe("bad_request");
    expect(errorCodeForStatus(401)).toBe("unauthenticated");
    expect(errorCodeForStatus(403)).toBe("forbidden");
    expect(errorCodeForStatus(404)).toBe("not_found");
    expect(errorCodeForStatus(409)).toBe("conflict");
    expect(errorCodeForStatus(410)).toBe("gone");
    expect(errorCodeForStatus(429)).toBe("rate_limited");
    expect(errorCodeForStatus(500)).toBe("internal_error");
  });

  it("falls back to error for unknown status (legacy parity)", () => {
    expect(errorCodeForStatus(418)).toBe("error");
  });

  it("round-trips code -> status for client-facing codes", () => {
    for (const code of ERROR_CODES) {
      const status = statusForErrorCode(code);
      expect(typeof status).toBe("number");
      expect(status).toBeGreaterThanOrEqual(400);
    }
  });

  it("validates a well-formed envelope", () => {
    const parsed = errorEnvelopeSchema.parse({
      error: { code: "not_found", message: "gone", traceId: "abc" },
    });
    expect(parsed.error.code).toBe("not_found");
  });

  it("rejects an envelope with an unknown code", () => {
    expect(() =>
      errorEnvelopeSchema.parse({ error: { code: "nope", message: "x" } }),
    ).toThrow();
  });
});
