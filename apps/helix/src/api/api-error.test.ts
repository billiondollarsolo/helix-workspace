import { describe, expect, it } from "vitest";
import {
  ApiError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  ForbiddenError,
  BadRequestError,
  ConflictError,
} from "./api-error.js";

describe("ApiError", () => {
  it("carries code + status", () => {
    const e = new NotFoundError("gone");
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("not_found");
    expect(e.statusCode).toBe(404);
  });

  it("carries retryAfterSeconds for rate limiting", () => {
    const e = new RateLimitedError("slow down", { retryAfterSeconds: 30 });
    expect(e.statusCode).toBe(429);
    expect(e.retryAfterSeconds).toBe(30);
  });

  it("maps subclasses to stable codes", () => {
    expect(new BadRequestError("x").code).toBe("bad_request");
    expect(new UnauthorizedError("x").code).toBe("unauthenticated");
    expect(new ForbiddenError("x").code).toBe("forbidden");
    expect(new ConflictError("x").code).toBe("conflict");
  });
});
