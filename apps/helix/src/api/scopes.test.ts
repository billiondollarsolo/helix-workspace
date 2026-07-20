import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { ForbiddenError, UnauthorizedError } from "./api-error.js";
import { actorHasScope, requireActorScope } from "./scopes.js";

const base = {
  id: "a1",
  orgId: "o1",
  type: "user" as const,
};

describe("actorHasScope", () => {
  it("returns true when the exact scope is present", () => {
    expect(actorHasScope({ ...base, scopes: ["drive.read"] }, "drive.read")).toBe(true);
  });

  it("returns false when the scope is missing", () => {
    expect(actorHasScope({ ...base, scopes: ["mail.read"] }, "drive.read")).toBe(false);
    expect(actorHasScope({ ...base }, "drive.read")).toBe(false);
  });

  it("grants all scopes to system actors and wildcards", () => {
    expect(
      actorHasScope(
        { id: "system", orgId: "o", type: "system", scopes: [] },
        "drive.read",
      ),
    ).toBe(true);
    expect(actorHasScope({ ...base, scopes: ["*"] }, "drive.read")).toBe(true);
    expect(actorHasScope({ ...base, scopes: ["admin.*"] }, "drive.read")).toBe(true);
  });
});

describe("requireActorScope", () => {
  it("throws UnauthorizedError for anonymous", () => {
    const anon: Actor = {
      id: "anonymous",
      orgId: "00000000-0000-0000-0000-000000000000",
      type: "agent",
      scopes: [],
    };
    expect(() => requireActorScope(anon, "drive.read")).toThrow(UnauthorizedError);
  });

  it("throws ForbiddenError when scope is missing", () => {
    expect(() => requireActorScope({ ...base, scopes: [] }, "drive.read")).toThrow(
      ForbiddenError,
    );
  });

  it("passes when scope is present", () => {
    expect(() =>
      requireActorScope({ ...base, scopes: ["drive.read"] }, "drive.read"),
    ).not.toThrow();
  });
});
