import { describe, expect, it } from "vitest";
import { createWebDavRateLimiter, isSecureWebDavRequest } from "./webdav-security.js";

describe("WebDAV transport and rate security", () => {
  it("accepts direct or trusted-proxy TLS and rejects plaintext", () => {
    expect(isSecureWebDavRequest({ protocol: "https" })).toBe(true);
    expect(isSecureWebDavRequest({ protocol: "http", forwardedProto: "https" })).toBe(true);
    expect(isSecureWebDavRequest({ protocol: "http" })).toBe(false);
    expect(isSecureWebDavRequest({ protocol: "http", forwardedProto: "http" })).toBe(false);
  });

  it("bounds repeated attempts within a window", () => {
    let now = 0;
    const limiter = createWebDavRateLimiter(() => now);
    expect(limiter.consume("auth:ip", 2, 60_000).allowed).toBe(true);
    expect(limiter.consume("auth:ip", 2, 60_000).allowed).toBe(true);
    expect(limiter.consume("auth:ip", 2, 60_000)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    now = 60_000;
    expect(limiter.consume("auth:ip", 2, 60_000).allowed).toBe(true);
  });
});
