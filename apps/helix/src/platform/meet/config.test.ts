import { describe, expect, it } from "vitest";
import { loadEnv } from "../../config/env.js";
import {
  DEVELOPMENT_MEET_JWT_SECRET,
  DEVELOPMENT_MEET_WEBHOOK_SECRET,
  meetSecrets,
} from "./config.js";

const database = "postgres://helix:test@localhost:5432/helix";

describe("Meet secrets", () => {
  it("keeps explicit development-only defaults outside production", () => {
    expect(meetSecrets(loadEnv({ DATABASE_URL: database, NODE_ENV: "development" }))).toEqual({
      jwtSecret: DEVELOPMENT_MEET_JWT_SECRET,
      webhookSecret: DEVELOPMENT_MEET_WEBHOOK_SECRET,
    });
  });

  it("rejects missing, default, and short production secrets", () => {
    expect(() => meetSecrets(loadEnv({ DATABASE_URL: database, NODE_ENV: "production" }))).toThrow(
      "MEET_JITSI_JWT_SECRET",
    );
    expect(() =>
      meetSecrets(
        loadEnv({
          DATABASE_URL: database,
          NODE_ENV: "production",
          MEET_JITSI_JWT_SECRET: DEVELOPMENT_MEET_JWT_SECRET,
          MEET_JITSI_WEBHOOK_SHARED_SECRET: "x".repeat(48),
        }),
      ),
    ).toThrow("MEET_JITSI_JWT_SECRET");
    expect(() =>
      meetSecrets(
        loadEnv({
          DATABASE_URL: database,
          NODE_ENV: "production",
          MEET_JITSI_JWT_SECRET: "x".repeat(48),
          MEET_JITSI_WEBHOOK_SHARED_SECRET: "too-short",
        }),
      ),
    ).toThrow("MEET_JITSI_WEBHOOK_SHARED_SECRET");
  });

  it("accepts explicit strong production secrets", () => {
    expect(
      meetSecrets(
        loadEnv({
          DATABASE_URL: database,
          NODE_ENV: "production",
          MEET_JITSI_JWT_SECRET: "jwt_" + "a".repeat(48),
          MEET_JITSI_WEBHOOK_SHARED_SECRET: "webhook_" + "b".repeat(48),
        }),
      ),
    ).toMatchObject({
      jwtSecret: "jwt_" + "a".repeat(48),
      webhookSecret: "webhook_" + "b".repeat(48),
    });
  });
});
