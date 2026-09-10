import type { Actor, ActorRoleBinding, ResourceRef, RoleBindingScope } from "@helix/sdk-types";
import { z } from "zod";
import { isKnownScope, permissionsSchema, type Permission } from "./scope-catalog.js";

const permissionSetSchema = z
  .object({
    allow: permissionsSchema.default([]),
    deny: permissionsSchema.default([]),
  })
  .superRefine(({ allow, deny }, context) => {
    const denied = new Set(deny);
    for (const permission of allow) {
      if (denied.has(permission)) {
        context.addIssue({
          code: "custom",
          message: `Permission cannot be both allowed and denied: ${permission}`,
        });
      }
    }
  });

export const customRoleInputSchema = z.object({
  orgId: z.string().uuid(),
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/u),
  displayName: z.string().trim().min(1).max(120),
  description: z.string().max(1_000).default(""),
  permissions: permissionSetSchema,
});

const principalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("membership"), id: z.string().uuid() }),
  z.object({ type: z.literal("service_account"), id: z.string().uuid() }),
  z.object({ type: z.literal("group"), id: z.string().uuid() }),
]);

const bindingScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("org") }),
  z.object({ type: z.literal("org_unit"), id: z.string().uuid() }),
  z.object({ type: z.literal("group"), id: z.string().uuid() }),
  z.object({
    type: z.literal("resource"),
    resourceType: z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/u),
    id: z.string().min(1).max(512),
  }),
]);

export const roleBindingInputSchema = z.object({
  orgId: z.string().uuid(),
  roleId: z.string().uuid(),
  principal: principalSchema,
  scope: bindingScopeSchema,
});

export const DELEGATED_ADMIN_ROLE_PERMISSIONS = {
  helpdesk_admin: "admin.helpdesk",
  user_admin: "admin.users",
  group_admin: "admin.groups",
  domain_admin: "admin.domains",
  security_admin: "admin.security",
  audit_admin: "admin.audit",
  billing_admin: "admin.billing",
  retention_admin: "admin.retention",
  mail_admin: "mail.admin",
} as const satisfies Record<string, Permission>;

const storedBindingSchema = z
  .object({
    roleId: z.string().uuid(),
    allow: permissionsSchema,
    deny: permissionsSchema,
    scopeType: z.enum(["org", "org_unit", "group", "resource"]),
    scopeId: z.string().nullable(),
    resourceType: z.string().nullable(),
  })
  .superRefine((binding, context) => {
    if (binding.allow.some((permission) => binding.deny.includes(permission))) {
      context.addIssue({ code: "custom", message: "Role grant has conflicting effects." });
    }
    const noId = binding.scopeType === "org";
    const resource = binding.scopeType === "resource";
    if ((noId && binding.scopeId !== null) || (!noId && binding.scopeId === null)) {
      context.addIssue({ code: "custom", message: "Role grant has an invalid scope identifier." });
    }
    if (
      (resource && binding.resourceType === null) ||
      (!resource && binding.resourceType !== null)
    ) {
      context.addIssue({ code: "custom", message: "Role grant has an invalid resource type." });
    }
  });

/** Parse a database authorization snapshot. Any malformed entry fails closed as a unit. */
export function parseActorRoleBindings(value: unknown): readonly ActorRoleBinding[] {
  const parsed = z.array(storedBindingSchema).safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.map((binding) => ({
    roleId: binding.roleId,
    allow: binding.allow,
    deny: binding.deny,
    scope: storedScope(binding),
  }));
}

/** Keep OAuth/API-key grants inside the credential's explicit scope ceiling. */
export function limitRoleBindings(
  bindings: readonly ActorRoleBinding[],
  ceiling: readonly string[],
): readonly ActorRoleBinding[] {
  const allowed = new Set(ceiling);
  return bindings.map((binding) => ({
    ...binding,
    allow: binding.allow.filter((permission) => allowed.has(permission)),
  }));
}

/** Exact-match, tenant-bound authorization with global deny precedence. */
export function actorHasPermission(
  actor: Actor,
  permission: string,
  resource: ResourceRef = { type: "org", orgId: actor.orgId },
): boolean {
  if (actor.type === "system") return true;
  if (!isKnownScope(permission)) return false;
  if (resource.orgId !== undefined && resource.orgId !== actor.orgId) return false;

  const roleDecision = actorRoleDecision(actor, permission, resource);
  if (roleDecision === "deny") return false;
  return roleDecision === "allow" || (actor.scopes?.includes(permission) ?? false);
}

export function actorRoleDecision(
  actor: Actor,
  permission: string,
  resource: ResourceRef,
): "allow" | "deny" | "none" {
  if (!isKnownScope(permission)) return "deny";
  if (resource.orgId !== undefined && resource.orgId !== actor.orgId) return "deny";
  const bindings = (actor.roleBindings ?? []).filter((binding) =>
    roleScopeMatches(binding.scope, resource),
  );
  if (bindings.some((binding) => binding.deny.includes(permission))) return "deny";
  return bindings.some((binding) => binding.allow.includes(permission)) ? "allow" : "none";
}

function roleScopeMatches(scope: RoleBindingScope, resource: ResourceRef): boolean {
  if (scope.type === "org") return true;
  if (scope.type === "resource") {
    return resource.type === scope.resourceType && resource.id === scope.id;
  }
  const attribute = scope.type === "org_unit" ? "orgUnitId" : "groupId";
  return (
    (resource.type === scope.type && resource.id === scope.id) ||
    resource.attributes?.[attribute] === scope.id
  );
}

function storedScope(binding: z.infer<typeof storedBindingSchema>): RoleBindingScope {
  if (binding.scopeType === "org") return { type: "org" };
  const id = binding.scopeId as string;
  if (binding.scopeType === "resource") {
    return { type: "resource", resourceType: binding.resourceType as string, id };
  }
  return { type: binding.scopeType, id };
}
