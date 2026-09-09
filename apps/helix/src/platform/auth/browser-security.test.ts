import { describe, expect, it } from "vitest";
import {
  browserSecurityHeaders,
  createCsrfToken,
  csrfTokenFromCookie,
  isTrustedCookieMutation,
  isTrustedCorsOrigin,
  normalizeTrustedOrigins,
  serializeCsrfCookie,
} from "./browser-security.js";

const origins = normalizeTrustedOrigins([
  "https://workspace.example/path-is-ignored",
  "http://localhost:5173",
  "not a URL",
]);

describe("browser request trust", () => {
  it("allows only configured HTTP origins for credentialed CORS", () => {
    expect(isTrustedCorsOrigin("https://workspace.example", origins)).toBe(true);
    expect(isTrustedCorsOrigin("https://evil.example", origins)).toBe(false);
    expect(isTrustedCorsOrigin("null", origins)).toBe(false);
    expect(isTrustedCorsOrigin(undefined, origins)).toBe(true);
  });

  it("rejects cross-origin and originless session-cookie mutations", () => {
    const csrfToken = "a".repeat(43);
    const mutation = {
      method: "POST",
      cookie: `helix_session=signed-token; helix_csrf=${csrfToken}`,
      csrfToken,
      trustedOrigins: origins,
    };
    expect(isTrustedCookieMutation({ ...mutation, origin: "https://workspace.example" })).toBe(
      true,
    );
    expect(isTrustedCookieMutation({ ...mutation, origin: "https://evil.example" })).toBe(false);
    expect(isTrustedCookieMutation(mutation)).toBe(false);
    expect(
      isTrustedCookieMutation({
        ...mutation,
        cookie: `__Secure-helix_session=signed-token; __Host-helix_csrf=${csrfToken}`,
        origin: "https://evil.example",
      }),
    ).toBe(false);
    expect(
      isTrustedCookieMutation({
        ...mutation,
        csrfToken: "b".repeat(43),
        origin: "https://workspace.example",
      }),
    ).toBe(false);
    expect(
      isTrustedCookieMutation({
        method: "POST",
        cookie: "helix_session=signed-token",
        origin: "https://workspace.example",
        trustedOrigins: origins,
      }),
    ).toBe(false);
  });

  it("issues strict readable CSRF cookies with high-entropy tokens", () => {
    const token = createCsrfToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(csrfTokenFromCookie(`x=1; __Host-helix_csrf=${token}`)).toBe(token);
    expect(serializeCsrfCookie(token, true)).toBe(
      `__Host-helix_csrf=${token}; Path=/; SameSite=Strict; Secure`,
    );
    expect(serializeCsrfCookie(token, false)).toBe(`helix_csrf=${token}; Path=/; SameSite=Strict`);
  });

  it("does not impose browser CSRF checks on safe or non-cookie requests", () => {
    expect(
      isTrustedCookieMutation({
        method: "GET",
        origin: "https://evil.example",
        cookie: "helix_session=signed-token",
        trustedOrigins: origins,
      }),
    ).toBe(true);
    expect(isTrustedCookieMutation({ method: "POST", trustedOrigins: origins })).toBe(true);
  });
});

describe("browser security response headers", () => {
  it("uses a narrow explicit frame origin and complete production defenses", () => {
    const headers = browserSecurityHeaders({
      production: true,
      jitsiPublicUrl: "https://meet.example.com/room",
    });

    expect(headers["strict-transport-security"]).toContain("includeSubDomains");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain(
      "frame-src 'self' https://meet.example.com",
    );
    expect(headers["permissions-policy"]).toContain("geolocation=()");
    expect(headers).toMatchObject({
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "cross-origin-opener-policy": "same-origin-allow-popups",
      "cross-origin-resource-policy": "same-origin",
      "origin-agent-cluster": "?1",
    });
    // COEP blocks Jitsi and editor/preview resources that are not CORP-aware.
    expect(headers).not.toHaveProperty("cross-origin-embedder-policy");
  });

  it("does not emit HSTS or trust insecure frame origins outside production", () => {
    const headers = browserSecurityHeaders({
      production: false,
      jitsiPublicUrl: "http://localhost:28452",
    });
    expect(headers).not.toHaveProperty("strict-transport-security");
    expect(headers["content-security-policy"]).toContain("frame-src 'self'");
    expect(headers["content-security-policy"]).not.toContain("http://localhost:28452");
  });
});
