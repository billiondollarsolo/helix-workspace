import { describe, expect, it } from "vitest";
import {
  DEFAULT_JITSI_JWT_TTL_SECONDS,
  MAX_JITSI_JWT_TTL_SECONDS,
  MIN_JITSI_JWT_TTL_SECONDS,
  mintJitsiJwt,
  resolveJitsiJwtTtlSeconds,
} from "./jwt.js";

describe("Jitsi JWT TTL (MT.3)", () => {
  it("defaults to a short-lived 15-minute TTL", () => {
    expect(DEFAULT_JITSI_JWT_TTL_SECONDS).toBe(15 * 60);
    expect(resolveJitsiJwtTtlSeconds({})).toBe(DEFAULT_JITSI_JWT_TTL_SECONDS);
  });

  it("clamps requested TTL to the configured maximum", () => {
    expect(
      resolveJitsiJwtTtlSeconds({
        ttlSeconds: 24 * 60 * 60,
        maxTtlSeconds: MAX_JITSI_JWT_TTL_SECONDS,
      }),
    ).toBe(MAX_JITSI_JWT_TTL_SECONDS);
    expect(resolveJitsiJwtTtlSeconds({ ttlSeconds: 120, maxTtlSeconds: 60 })).toBe(60);
  });

  it("rejects TTL below the minimum", () => {
    expect(() => resolveJitsiJwtTtlSeconds({ ttlSeconds: MIN_JITSI_JWT_TTL_SECONDS - 1 })).toThrow(
      "ttlSeconds",
    );
  });

  it("mints room-bound HS256 tokens with short exp and returns ttlSeconds", () => {
    const now = new Date("2026-05-20T12:00:00.000Z");
    const minted = mintJitsiJwt({
      secret: "test-secret",
      issuer: "helix",
      audience: "jitsi",
      subject: "meet.helix.test",
      room: "launch-review",
      now,
      user: { id: "actor-1", name: "Ada", email: "ada@example.com", moderator: true },
    });

    expect(minted.ttlSeconds).toBe(DEFAULT_JITSI_JWT_TTL_SECONDS);
    expect(minted.expiresAt.toISOString()).toBe("2026-05-20T12:15:00.000Z");

    const [, payloadB64] = minted.token.split(".");
    expect(payloadB64).toBeDefined();
    const payload = JSON.parse(Buffer.from(payloadB64 ?? "", "base64url").toString("utf8")) as {
      readonly room: string;
      readonly exp: number;
      readonly iat: number;
      readonly context: { readonly user: { readonly id: string } };
    };
    expect(payload.room).toBe("launch-review");
    expect(payload.context.user.id).toBe("actor-1");
    expect(payload.exp - payload.iat).toBe(DEFAULT_JITSI_JWT_TTL_SECONDS);
    // Token body must not embed the secret.
    expect(minted.token).not.toContain("test-secret");
  });

  it("enforces maxTtlSeconds on mint even when caller asks for longer", () => {
    const now = new Date("2026-05-20T12:00:00.000Z");
    const minted = mintJitsiJwt({
      secret: "test-secret",
      issuer: "helix",
      room: "room-a",
      ttlSeconds: 7_200,
      maxTtlSeconds: 600,
      now,
      user: { id: "actor-1" },
    });
    expect(minted.ttlSeconds).toBe(600);
    expect(minted.expiresAt.toISOString()).toBe("2026-05-20T12:10:00.000Z");
  });
});
