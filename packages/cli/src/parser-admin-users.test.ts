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
