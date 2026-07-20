import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/helix",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadEnv", () => {
  it("parses a valid environment and applies defaults", () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_URL).toContain("postgres://");
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.CHAT_PRESENCE_TTL_SECONDS).toBe(60);
    expect(env.CHAT_WS_RATE_LIMIT_CAPACITY).toBe(30);
    expect(env.CHAT_WS_RATE_LIMIT_REFILL_PER_SECOND).toBe(3);
  });

  it("accepts CHAT_PRESENCE_TTL_SECONDS override", () => {
    const env = loadEnv({ ...base, CHAT_PRESENCE_TTL_SECONDS: "45" });
    expect(env.CHAT_PRESENCE_TTL_SECONDS).toBe(45);
  });

  it("rejects a non-numeric CHAT_PRESENCE_TTL_SECONDS", () => {
    expect(() => loadEnv({ ...base, CHAT_PRESENCE_TTL_SECONDS: "nope" })).toThrow(
      /CHAT_PRESENCE_TTL_SECONDS/,
    );
  });

  it("fails fast with a readable message when DATABASE_URL is missing in production", () => {
    expect(() =>
      loadEnv({ NODE_ENV: "production", REDIS_URL: base.REDIS_URL }),
    ).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadEnv({ ...base, PORT: "notaport" })).toThrow(/PORT/);
  });

  it("accepts empty REDIS_URL as undefined", () => {
    const env = loadEnv({ ...base, REDIS_URL: "" });
    expect(env.REDIS_URL).toBeUndefined();
  });
});
