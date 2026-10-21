import type { Actor, ToolContext, ToolDefinition } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "../../config/env.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { MEET_UNAVAILABLE_MEMBER_MESSAGE, registerMeetStatusTool } from "./availability.js";
import { meetSecrets, missingMeetSecrets } from "./config.js";

const database = "postgres://helix:test@localhost:5432/helix";
const localSecrets = {
  LIVEKIT_API_KEY: "helix",
  LIVEKIT_API_SECRET: "local_livekit_secret_for_this_checkout",
  MEET_CAPTURE_SECRET: "local_capture_secret_for_this_checkout",
};
const strong = (prefix: string) => `${prefix}_${"a".repeat(48)}`;

describe("Meet secrets", () => {
  it("leaves Meet unconfigured without LiveKit settings, in every environment", () => {
    for (const NODE_ENV of ["development", "test", "production"]) {
      const env = loadEnv({ DATABASE_URL: database, NODE_ENV });
      expect(meetSecrets(env)).toBeNull();
      expect(missingMeetSecrets(env)).toEqual([
        "LIVEKIT_API_KEY",
        "LIVEKIT_API_SECRET",
        "MEET_CAPTURE_SECRET",
      ]);
    }
    const partial = loadEnv({
      DATABASE_URL: database,
      NODE_ENV: "development",
      LIVEKIT_API_KEY: "helix",
      LIVEKIT_API_SECRET: localSecrets.LIVEKIT_API_SECRET,
    });
    expect(meetSecrets(partial)).toBeNull();
    expect(missingMeetSecrets(partial)).toEqual(["MEET_CAPTURE_SECRET"]);
  });

  it("uses the configured settings and defaults the media URL to the Workspace host", () => {
    const env = loadEnv({
      DATABASE_URL: database,
      NODE_ENV: "development",
      HELIX_PUBLIC_URL: "https://workspace.example.test",
      ...localSecrets,
    });
    expect(missingMeetSecrets(env)).toEqual([]);
    const config = meetSecrets(env);
    expect(config).toMatchObject({
      liveKit: {
        apiKey: "helix",
        apiSecret: localSecrets.LIVEKIT_API_SECRET,
        publicUrl: "wss://workspace.example.test",
        internalUrl: "http://livekit:7880",
      },
      captureSecret: localSecrets.MEET_CAPTURE_SECRET,
    });
    expect(config?.guestInviteSecret).toMatch(/^[\w-]{43}$/u);
    expect(config?.guestInviteSecret).not.toBe(localSecrets.MEET_CAPTURE_SECRET);
  });

  it("honours an explicit LiveKit URL", () => {
    const env = loadEnv({
      DATABASE_URL: database,
      NODE_ENV: "development",
      LIVEKIT_PUBLIC_URL: "ws://localhost:28451",
      LIVEKIT_INTERNAL_URL: "http://127.0.0.1:7880",
      ...localSecrets,
    });
    expect(meetSecrets(env)?.liveKit).toMatchObject({
      publicUrl: "ws://localhost:28451",
      internalUrl: "http://127.0.0.1:7880",
    });
  });

  it("rejects default and short production secrets", () => {
    const production = (overrides: Record<string, string>) =>
      meetSecrets(
        loadEnv({
          DATABASE_URL: database,
          NODE_ENV: "production",
          LIVEKIT_API_KEY: "helix",
          LIVEKIT_API_SECRET: strong("livekit"),
          MEET_CAPTURE_SECRET: strong("capture"),
          ...overrides,
        }),
      );
    expect(() =>
      production({ LIVEKIT_API_SECRET: "helix_dev_livekit_api_secret_change_me" }),
    ).toThrow("LIVEKIT_API_SECRET");
    expect(() => production({ MEET_CAPTURE_SECRET: "too-short" })).toThrow("MEET_CAPTURE_SECRET");
    expect(production({})).toMatchObject({ captureSecret: strong("capture") });
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
    const run = statusTool(["LIVEKIT_API_SECRET", "MEET_CAPTURE_SECRET"]);
    const forAdmin = (await run(admin)) as { available: boolean; message: string };
    expect(forAdmin).toMatchObject({ available: false, reason: "not_configured" });
    expect(forAdmin.message).toContain("Set LIVEKIT_API_SECRET, MEET_CAPTURE_SECRET");
    expect(forAdmin.message).toContain("restart Helix");
    await expect(run(member)).resolves.toEqual({
      available: false,
      reason: "not_configured",
      message: MEET_UNAVAILABLE_MEMBER_MESSAGE,
    });
  });
});
