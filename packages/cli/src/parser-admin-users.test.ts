import { describe, expect, it } from "vitest";
import { buildHelixRequest } from "./client.js";
import { parseCliArgs } from "./parser.js";

const actorId = "88888888-8888-4888-8888-888888888888";

describe("helix admin users suspend|restore", () => {
  it("parses both actions and requires the actor id", () => {
    expect(parseCliArgs(["admin", "users", "suspend", "--actor-id", actorId])).toEqual({
      kind: "admin-user-lifecycle",
      action: "suspend",
      actorId,
    });
    expect(parseCliArgs(["admin", "users", "restore", "--actor-id", actorId])).toEqual({
      kind: "admin-user-lifecycle",
      action: "restore",
      actorId,
    });
    expect(() => parseCliArgs(["admin", "users", "suspend"])).toThrow(
      "helix admin users <suspend|restore> --actor-id <id>",
    );
  });

  it("posts to the admin user lifecycle routes", () => {
    for (const action of ["suspend", "restore"] as const) {
      expect(
        buildHelixRequest(
          { kind: "admin-user-lifecycle", action, actorId },
          { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" },
        ),
      ).toMatchObject({
        url: `https://helix.example/v1/api/admin/users/${actorId}/${action}`,
        init: { method: "POST", body: "{}" },
      });
    }
  });
});

describe("helix admin users invite|resend-invite|revoke-invite", () => {
  it("parses an invitation with optional name and admin role", () => {
    expect(parseCliArgs(["admin", "users", "invite", "--email", "ada@example.com"])).toEqual({
      kind: "admin-user-invite",
      email: "ada@example.com",
    });
    expect(
      parseCliArgs([
        "admin",
        "users",
        "invite",
        "--email",
        "ada@example.com",
        "--name",
        "Ada Lovelace",
        "--admin",
      ]),
    ).toEqual({
      kind: "admin-user-invite",
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      role: "admin",
    });
    expect(() => parseCliArgs(["admin", "users", "invite"])).toThrow(
      "helix admin users invite --email <email>",
    );
  });

  it("parses resend and revoke and requires the actor id", () => {
    expect(parseCliArgs(["admin", "users", "resend-invite", "--actor-id", actorId])).toEqual({
      kind: "admin-user-invitation",
      action: "resend",
      actorId,
    });
    expect(parseCliArgs(["admin", "users", "revoke-invite", "--actor-id", actorId])).toEqual({
      kind: "admin-user-invitation",
      action: "revoke",
      actorId,
    });
    expect(() => parseCliArgs(["admin", "users", "revoke-invite"])).toThrow(
      "helix admin users <resend-invite|revoke-invite> --actor-id <id>",
    );
  });

  it("posts to the admin invitation routes", () => {
    const env = { HELIX_BASE_URL: "https://helix.example", HELIX_ACCESS_TOKEN: "token-1" };
    expect(
      buildHelixRequest(
        { kind: "admin-user-invite", email: "ada@example.com", displayName: "Ada", role: "admin" },
        env,
      ),
    ).toMatchObject({
      url: "https://helix.example/v1/api/admin/users/invite",
      init: {
        method: "POST",
        body: '{"email":"ada@example.com","displayName":"Ada","role":"admin"}',
      },
    });
    expect(
      buildHelixRequest({ kind: "admin-user-invite", email: "ada@example.com" }, env),
    ).toMatchObject({ init: { body: '{"email":"ada@example.com"}' } });
    for (const action of ["resend", "revoke"] as const) {
      expect(
        buildHelixRequest({ kind: "admin-user-invitation", action, actorId }, env),
      ).toMatchObject({
        url: `https://helix.example/v1/api/admin/users/${actorId}/invite/${action}`,
        init: { method: "POST", body: "{}" },
      });
    }
  });
});
