import fastify from "fastify";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  evaluateWebSocketOrigin,
  installTrustedOriginPolicy,
  isTrustedOrigin,
  parseTrustedOrigins,
} from "./origin-policy.js";

describe("parseTrustedOrigins", () => {
  it("canonicalizes, deduplicates, and exactly matches configured origins", () => {
    const origins = parseTrustedOrigins(
      "https://APP.example.test, https://app.example.test:443, http://localhost:3000",
    );

    expect(origins).toEqual(["https://app.example.test", "http://localhost:3000"]);
    expect(isTrustedOrigin("https://app.example.test", origins)).toBe(true);
    expect(isTrustedOrigin("https://app.example.test.evil.invalid", origins)).toBe(false);
    expect(isTrustedOrigin("https://app.example.test:444", origins)).toBe(false);
    expect(isTrustedOrigin("https://app.example.test/", origins)).toBe(false);
  });

  it.each([
    "*",
    "null",
    "/example/",
    "https://user:secret@app.example.test",
    "https://app.example.test/path",
    "https://app.example.test?next=evil",
    "https://app.example.test#fragment",
    "file:///tmp/socket",
  ])("rejects non-origin allowlist entry %s without reflecting its contents", (entry) => {
    expect(() => parseTrustedOrigins(entry)).toThrow("Invalid trusted origin entry");
  });
});

describe("installTrustedOriginPolicy", () => {
  it("permits the exact trusted origin and emits credentialed CORS headers", async () => {
    const app = fastify();
    await installTrustedOriginPolicy(app, ["https://app.example.test"]);
    app.get("/private", async () => ({ ok: true }));

    const response = await app.inject({
      method: "GET",
      url: "/private",
      headers: {
        origin: "https://app.example.test",
        cookie: "helix_session=opaque",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("https://app.example.test");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    await app.close();
  });

  it("rejects an evil credentialed origin before a mutating handler runs", async () => {
    const app = fastify();
    let calls = 0;
    await installTrustedOriginPolicy(app, ["https://app.example.test"]);
    app.post("/private", async () => {
      calls += 1;
      return { ok: true };
    });

    const response = await app.inject({
      method: "POST",
      url: "/private",
      headers: {
        origin: "https://app.example.test.evil.invalid",
        cookie: "helix_session=opaque",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.body).not.toContain("opaque");
    expect(calls).toBe(0);
    await app.close();
  });
});

describe("evaluateWebSocketOrigin", () => {
  const trustedOrigin = "https://app.example.test";
  const trusted = [trustedOrigin];

  it("accepts an exact browser origin, including session-cookie authentication", () => {
    expect(
      evaluateWebSocketOrigin(
        request({ origin: trustedOrigin, cookie: "helix_session=opaque" }),
        trusted,
      ),
    ).toEqual({ allowed: true, browser: true });
  });

  it("rejects an evil origin even when a valid cookie is present", () => {
    expect(
      evaluateWebSocketOrigin(
        request({
          origin: "https://app.example.test.evil.invalid",
          cookie: "helix_session=opaque",
        }),
        trusted,
      ),
    ).toEqual({ allowed: false, reason: "untrusted_origin" });
  });

  it("allows missing Origin only on the cookie-free non-browser handshake", () => {
    expect(evaluateWebSocketOrigin(request({ authorization: "Bearer opaque" }), trusted)).toEqual({
      allowed: true,
      browser: false,
      initialCredential: true,
    });
    expect(evaluateWebSocketOrigin(request({}), trusted)).toEqual({
      allowed: true,
      browser: false,
      initialCredential: false,
    });
    expect(evaluateWebSocketOrigin(request({ cookie: "helix_session=opaque" }), trusted)).toEqual({
      allowed: false,
      reason: "missing_origin_with_cookie",
    });
  });
});

function request(headers: Record<string, string>): FastifyRequest {
  return { headers, query: {} } as unknown as FastifyRequest;
}
