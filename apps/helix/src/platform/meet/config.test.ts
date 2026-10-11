import type { Actor, ToolContext, ToolDefinition } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "../../config/env.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { MEET_UNAVAILABLE_MEMBER_MESSAGE, registerMeetStatusTool } from "./availability.js";
import { meetSecrets, missingMeetSecrets } from "./config.js";

const database = "postgres://helix:test@localhost:5432/helix";
const localSecrets = {
  MEET_JITSI_JWT_SECRET: "local_jwt_secret_for_this_checkout",
  MEET_JITSI_WEBHOOK_SHARED_SECRET: "local_webhook_secret_for_this_checkout",
};

describe("Meet secrets", () => {
  it("leaves Meet unconfigured without Jitsi secrets, in every environment", () => {
    for (const NODE_ENV of ["development", "test", "production"]) {
      const env = loadEnv({ DATABASE_URL: database, NODE_ENV });
      expect(meetSecrets(env)).toBeNull();
      expect(missingMeetSecrets(env)).toEqual([
        "MEET_JITSI_JWT_SECRET",
        "MEET_JITSI_WEBHOOK_SHARED_SECRET",
      ]);
    }
    const partial = loadEnv({
      DATABASE_URL: database,
      NODE_ENV: "development",
      MEET_JITSI_JWT_SECRET: localSecrets.MEET_JITSI_JWT_SECRET,
    });
    expect(meetSecrets(partial)).toBeNull();
    expect(missingMeetSecrets(partial)).toEqual(["MEET_JITSI_WEBHOOK_SHARED_SECRET"]);
  });

  it("uses the secrets a local or test setup configures", () => {
    const env = loadEnv({ DATABASE_URL: database, NODE_ENV: "development", ...localSecrets });
    expect(missingMeetSecrets(env)).toEqual([]);
    expect(meetSecrets(env)).toEqual({
      jwtSecret: localSecrets.MEET_JITSI_JWT_SECRET,
      webhookSecret: localSecrets.MEET_JITSI_WEBHOOK_SHARED_SECRET,
    });
  });

  it("rejects default and short production secrets", () => {
    expect(() =>
      meetSecrets(
        loadEnv({
          DATABASE_URL: database,
          NODE_ENV: "production",
          MEET_JITSI_JWT_SECRET: "helix_dev_jitsi_jwt_secret_change_me",
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

describe("meet.status", () => {
  const member: Actor = { id: "member", orgId: "org", type: "user", scopes: ["meet.read"] };
  const admin: Actor = { ...member, id: "admin", scopes: ["meet.read", "admin.config.read"] };

  function statusTool(missingSecrets: readonly string[]): (actor: Actor) => Promise<unknown> {
    let tool: ToolDefinition | undefined;
    registerMeetStatusTool(
      {
        register: (definition: ToolDefinition) => {
          tool = definition;
        },
      } as unknown as RuntimeToolRegistry,
      { missingSecrets },
    );
    return async (actor) => {
      if (tool === undefined) throw new Error("meet.status was not registered");
      const ctx = { actor, audit: vi.fn() } as unknown as ToolContext;
      return tool.handler(tool.inputSchema.parse({}), ctx);
    };
  }

  it("reports Meet available once its secrets are configured", async () => {
    await expect(statusTool([])(member)).resolves.toEqual({ available: true });
  });

  it("tells admins what to configure and members whom to ask", async () => {
    const run = statusTool(["MEET_JITSI_JWT_SECRET", "MEET_JITSI_WEBHOOK_SHARED_SECRET"]);
    const forAdmin = (await run(admin)) as { available: boolean; message: string };
    expect(forAdmin).toMatchObject({ available: false, reason: "not_configured" });
    expect(forAdmin.message).toContain(
      "Set MEET_JITSI_JWT_SECRET and MEET_JITSI_WEBHOOK_SHARED_SECRET",
    );
    expect(forAdmin.message).toContain("restart Helix");
    await expect(run(member)).resolves.toEqual({
      available: false,
      reason: "not_configured",
      message: MEET_UNAVAILABLE_MEMBER_MESSAGE,
    });
  });
});
