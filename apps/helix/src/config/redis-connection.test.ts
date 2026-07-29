import { describe, expect, it } from "vitest";
import { resolveRedisConnection } from "./redis-connection.js";

describe("resolveRedisConnection", () => {
  const readFile = () => Buffer.from("pem");

  it("requires authenticated TLS inputs in production", () => {
    expect(() =>
      resolveRedisConnection({ NODE_ENV: "production", REDIS_URL: "redis://redis:6379" }, readFile),
    ).toThrow("rediss:");
    expect(() =>
      resolveRedisConnection(
        { NODE_ENV: "production", REDIS_URL: "rediss://redis:6379" },
        readFile,
      ),
    ).toThrow("pinned TLS CA");
  });

  it("builds a CA-pinned TLS client without logging credential material", () => {
    const connection = resolveRedisConnection(
      {
        NODE_ENV: "production",
        REDIS_URL: "rediss://:secret@redis:6379",
        REDIS_TLS_CA_FILE: "/run/secrets/redis_ca",
      },
      readFile,
    );
    expect(connection?.url).toBe("rediss://:secret@redis:6379");
    expect(connection?.options.tls).toMatchObject({
      rejectUnauthorized: true,
      servername: "redis",
      ca: Buffer.from("pem"),
    });
  });

  it("rejects partial client certificate configuration", () => {
    expect(() =>
      resolveRedisConnection(
        {
          REDIS_URL: "rediss://redis:6379",
          REDIS_TLS_CERT_FILE: "/run/secrets/redis_cert",
        },
        readFile,
      ),
    ).toThrow("certificate and key");
  });
});
