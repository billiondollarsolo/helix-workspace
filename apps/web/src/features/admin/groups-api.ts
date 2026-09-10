import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { ADMIN_QUERY_DEFAULTS } from "@/features/admin/console/request-budget";
import { ensureOk, parseResponse } from "@/features/admin/api-response";

/**
 * Admin Console — Groups & Organizational Units client.
 *
 * Talks to the platform admin REST surface:
 *  - `/api/admin/org-units`          — OU tree (list / create / patch / delete)
 *  - `/api/admin/groups`             — groups (list / create / patch / delete)
 *  - `/api/admin/groups/:id/members` — group membership (list / add / remove)
 *
 * Backend responses are validated at the trust boundary with Zod so a
 * malformed payload can never reach the React tree.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

// ---------------------------------------------------------------------------
// Org units
// ---------------------------------------------------------------------------

const orgUnitSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  path: z.string(),
  description: z.string(),
  memberCount: z.number().int(),
  childCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type OrgUnit = z.infer<typeof orgUnitSchema>;

const orgUnitsResponseSchema = z.object({ orgUnits: z.array(orgUnitSchema) });
const orgUnitResponseSchema = z.object({ orgUnit: orgUnitSchema });

export interface CreateOrgUnitInput {
  readonly name: string;
  readonly description?: string;
  readonly parentId?: string | null;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const GROUP_KINDS = ["group", "security", "mailing_list"] as const;
type GroupKind = (typeof GROUP_KINDS)[number];

const groupSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  kind: z.enum(GROUP_KINDS),
  description: z.string(),
  orgUnitId: z.string().nullable(),
  memberCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Group = z.infer<typeof groupSchema>;

const groupsResponseSchema = z.object({ groups: z.array(groupSchema) });
const groupResponseSchema = z.object({ group: groupSchema });

export interface CreateGroupInput {
  readonly name: string;
  readonly email?: string | null;
  readonly kind?: GroupKind;
  readonly description?: string;
  readonly orgUnitId?: string | null;
}

// ---------------------------------------------------------------------------
// Group members
// ---------------------------------------------------------------------------

const GROUP_MEMBER_ROLES = ["member", "manager", "owner"] as const;
type GroupMemberRole = (typeof GROUP_MEMBER_ROLES)[number];

const groupMemberSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  groupId: z.string(),
  actorId: z.string(),
  role: z.enum(GROUP_MEMBER_ROLES),
  createdAt: z.string(),
});

export type GroupMember = z.infer<typeof groupMemberSchema>;

const groupMembersResponseSchema = z.object({ members: z.array(groupMemberSchema) });
const groupMemberResponseSchema = z.object({ member: groupMemberSchema });

export interface AddGroupMemberInput {
  readonly actorId: string;
  readonly role?: GroupMemberRole;
}

// ---------------------------------------------------------------------------
// Query keys + options
// ---------------------------------------------------------------------------

export const groupsAdminQueryKeys = {
  orgUnits: () => ["admin", "org-units"] as const,
  groups: () => ["admin", "groups"] as const,
  groupMembers: (groupId: string) => ["admin", "groups", groupId, "members"] as const,
};

export function orgUnitsQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: groupsAdminQueryKeys.orgUnits(),
    queryFn: () => fetchOrgUnits(fetchImpl),
  });
}

export function groupsQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: groupsAdminQueryKeys.groups(),
    queryFn: () => fetchGroups(fetchImpl),
  });
}

export function groupMembersQueryOptions(
  groupId: string | null,
  fetchImpl: AuthFetch = authenticatedFetch,
) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: groupsAdminQueryKeys.groupMembers(groupId ?? ""),
    queryFn: () => fetchGroupMembers(groupId ?? "", fetchImpl),
    enabled: groupId !== null,
  });
}

// ---------------------------------------------------------------------------
// Org units — fetchers + mutations
// ---------------------------------------------------------------------------

async function fetchOrgUnits(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<readonly OrgUnit[]> {
  const response = await fetchImpl("/api/admin/org-units", { method: "GET" });
  return (await parseResponse(response, "load org units", orgUnitsResponseSchema)).orgUnits;
}

export async function createOrgUnit(
  input: CreateOrgUnitInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<OrgUnit> {
  const response = await fetchImpl("/api/admin/org-units", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return (await parseResponse(response, "create org unit", orgUnitResponseSchema)).orgUnit;
}

export async function deleteOrgUnit(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl(`/api/admin/org-units/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await ensureOk(response, "delete org unit");
}

// ---------------------------------------------------------------------------
// Groups — fetchers + mutations
// ---------------------------------------------------------------------------

async function fetchGroups(fetchImpl: AuthFetch = authenticatedFetch): Promise<readonly Group[]> {
  const response = await fetchImpl("/api/admin/groups", { method: "GET" });
  return (await parseResponse(response, "load groups", groupsResponseSchema)).groups;
}

export async function createGroup(
  input: CreateGroupInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<Group> {
  const response = await fetchImpl("/api/admin/groups", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return (await parseResponse(response, "create group", groupResponseSchema)).group;
}

export async function deleteGroup(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl(`/api/admin/groups/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await ensureOk(response, "delete group");
}

// ---------------------------------------------------------------------------
// Group members — fetchers + mutations
// ---------------------------------------------------------------------------

async function fetchGroupMembers(
  groupId: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<readonly GroupMember[]> {
  const response = await fetchImpl(`/api/admin/groups/${encodeURIComponent(groupId)}/members`, {
    method: "GET",
  });
  return (await parseResponse(response, "load group members", groupMembersResponseSchema)).members;
}

export async function addGroupMember(
  groupId: string,
  input: AddGroupMemberInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<GroupMember> {
  const response = await fetchImpl(`/api/admin/groups/${encodeURIComponent(groupId)}/members`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return (await parseResponse(response, "add group member", groupMemberResponseSchema)).member;
}

export async function removeGroupMember(
  groupId: string,
  actorId: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl(
    `/api/admin/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(actorId)}`,
    { method: "DELETE" },
  );
  await ensureOk(response, "remove group member");
}
