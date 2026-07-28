import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/helix",
  REDIS_URL: "redis://localhost:6379",
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
    expect(() => loadEnv({ NODE_ENV: "production", REDIS_URL: base.REDIS_URL })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadEnv({ ...base, PORT: "notaport" })).toThrow(/PORT/);
  });

  it("accepts empty REDIS_URL as undefined", () => {
    const env = loadEnv({ ...base, REDIS_URL: "" });
    expect(env.REDIS_URL).toBeUndefined();
  });

  it("loads an allowlisted secret from an absolute *_FILE path", () => {
    const directory = mkdtempSync(join(tmpdir(), "helix-env-test-"));
    temporaryDirectories.push(directory);
    const secretPath = join(directory, "better-auth-secret");
    writeFileSync(secretPath, "file-backed-secret-with-a-trailing-newline\n", {
      mode: 0o600,
    });

    const loaded = loadEnv({
      ...base,
      BETTER_AUTH_SECRET_FILE: secretPath,
    });

    expect(loaded.BETTER_AUTH_SECRET).toBe("file-backed-secret-with-a-trailing-newline");
  });

  it("rejects simultaneous inline and file-backed values without echoing either", () => {
    const directory = mkdtempSync(join(tmpdir(), "helix-env-test-"));
    temporaryDirectories.push(directory);
    const secretPath = join(directory, "better-auth-secret");
    const inlineSecret = "inline-secret-that-must-not-appear";
    const fileSecret = "file-secret-that-must-not-appear";
    writeFileSync(secretPath, fileSecret, { mode: 0o600 });

    let caught: unknown;
    try {
      loadEnv({
        ...base,
        BETTER_AUTH_SECRET: inlineSecret,
        BETTER_AUTH_SECRET_FILE: secretPath,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("BETTER_AUTH_SECRET_FILE");
    expect((caught as Error).message).not.toContain(inlineSecret);
    expect((caught as Error).message).not.toContain(fileSecret);
    expect((caught as Error).message).not.toContain(secretPath);
  });

  it("rejects relative and unreadable *_FILE inputs without echoing paths", () => {
    expect(() =>
      loadEnv({
        ...base,
        BETTER_AUTH_SECRET_FILE: "./relative-secret",
      }),
    ).toThrow(/BETTER_AUTH_SECRET_FILE/);

    const missingPath = "/definitely/not/a/helix/secret";
    let caught: unknown;
    try {
      loadEnv({ ...base, BETTER_AUTH_SECRET_FILE: missingPath });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(missingPath);
  });
});
