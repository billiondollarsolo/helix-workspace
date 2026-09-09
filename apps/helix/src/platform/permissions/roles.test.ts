import type { Actor, ActorRoleBinding, RoleBindingScope } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import {
  actorHasPermission,
  customRoleInputSchema,
  limitRoleBindings,
  parseActorRoleBindings,
  roleBindingInputSchema,
} from "./roles.js";

const ORG_A = "00000000-0000-4000-8000-000000000001";
const ORG_B = "00000000-0000-4000-8000-000000000002";
const ROLE = "00000000-0000-4000-8000-000000000011";
const ACTOR_A = "00000000-0000-4000-8000-000000000021";

function binding(
  scope: RoleBindingScope,
  allow: readonly string[] = [],
  deny: readonly string[] = [],
): ActorRoleBinding {
  return { roleId: ROLE, scope, allow, deny };
}

function actor(
  roleBindings: readonly ActorRoleBinding[] = [],
  scopes: readonly string[] = [],
): Actor {
  return { id: ACTOR_A, orgId: ORG_A, type: "user", scopes, roleBindings };
}

describe("minimal IAM role evaluation", () => {
  it("defaults to deny and applies exact structural scope across two tenants", () => {
    const matrix = [
      {
        name: "unbound action",
        actor: actor(),
        resource: { type: "org", orgId: ORG_A },
        allowed: false,
      },
      {
        name: "organization grant",
        actor: actor([binding({ type: "org" }, ["drive.read"])]),
        resource: { type: "file", id: "file-1", orgId: ORG_A },
        allowed: true,
      },
      {
        name: "other tenant",
        actor: actor([binding({ type: "org" }, ["drive.read"])]),
        resource: { type: "file", id: "file-1", orgId: ORG_B },
        allowed: false,
      },
      {
        name: "exact OU",
        actor: actor([binding({ type: "org_unit", id: "engineering" }, ["drive.read"])]),
        resource: {
          type: "file",
          id: "file-1",
          orgId: ORG_A,
          attributes: { orgUnitId: "engineering" },
        },
        allowed: true,
      },
      {
        name: "no OU prefix inheritance",
        actor: actor([binding({ type: "org_unit", id: "engineering" }, ["drive.read"])]),
        resource: {
          type: "file",
          id: "file-1",
          orgId: ORG_A,
          attributes: { orgUnitId: "engineering/platform" },
        },
        allowed: false,
      },
      {
        name: "exact group",
        actor: actor([binding({ type: "group", id: "group-a" }, ["drive.read"])]),
        resource: { type: "file", id: "file-1", orgId: ORG_A, attributes: { groupId: "group-a" } },
        allowed: true,
      },
      {
        name: "exact resource",
        actor: actor([
          binding({ type: "resource", resourceType: "file", id: "file-1" }, ["drive.read"]),
        ]),
        resource: { type: "file", id: "file-1", orgId: ORG_A },
        allowed: true,
      },
      {
        name: "no resource prefix inheritance",
        actor: actor([
          binding({ type: "resource", resourceType: "file", id: "folder/1" }, ["drive.read"]),
        ]),
        resource: { type: "file", id: "folder/1/child", orgId: ORG_A },
        allowed: false,
      },
    ] as const;

    for (const row of matrix) {
      expect(actorHasPermission(row.actor, "drive.read", row.resource), row.name).toBe(row.allowed);
    }
  });

  it("makes deny override direct and role grants for separation of duty", () => {
    const subject = actor(
      [
        binding({ type: "org" }, ["admin.audit", "admin.users"]),
        binding({ type: "org" }, [], ["admin.users"]),
      ],
      ["admin.users"],
    );

    expect(actorHasPermission(subject, "admin.audit")).toBe(true);
    expect(actorHasPermission(subject, "admin.users")).toBe(false);
    expect(actorHasPermission(subject, "admin.user")).toBe(false);
  });

  it("validates custom roles, binding shapes, persisted grants, and credential ceilings", () => {
    expect(() =>
      customRoleInputSchema.parse({
        orgId: ORG_A,
        key: "auditor",
        displayName: "Auditor",
        permissions: { allow: ["admin.audit"], deny: ["admin.users"] },
      }),
    ).not.toThrow();
    expect(() =>
      customRoleInputSchema.parse({
        orgId: ORG_A,
        key: "bad",
        displayName: "Bad",
        permissions: { allow: ["made.up"], deny: [] },
      }),
    ).toThrow();
    expect(() =>
      customRoleInputSchema.parse({
        orgId: ORG_A,
        key: "conflict",
        displayName: "Conflict",
        permissions: { allow: ["admin.users"], deny: ["admin.users"] },
      }),
    ).toThrow();
    expect(() =>
      roleBindingInputSchema.parse({
        orgId: ORG_A,
        roleId: ROLE,
        principal: { type: "membership", id: ACTOR_A },
        scope: { type: "resource", resourceType: "file", id: "file-1" },
      }),
    ).not.toThrow();
    expect(() =>
      roleBindingInputSchema.parse({
        orgId: ORG_A,
        roleId: ROLE,
        principal: { type: "group", id: ACTOR_A },
        scope: { type: "org" },
      }),
    ).not.toThrow();

    const parsed = parseActorRoleBindings([
      {
        roleId: ROLE,
        allow: ["drive.read", "drive.write"],
        deny: ["drive.delete"],
        scopeType: "org",
        scopeId: null,
        resourceType: null,
      },
    ]);
    expect(limitRoleBindings(parsed, ["drive.read"])[0]).toMatchObject({
      allow: ["drive.read"],
      deny: ["drive.delete"],
    });
    expect(parseActorRoleBindings([{ roleId: ROLE, allow: ["unknown"], deny: [] }])).toEqual([]);
  });
});
