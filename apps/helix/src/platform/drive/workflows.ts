import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import { BadRequestError } from "../../api/api-error.js";
import { withTenantIoSagaPostgresContext as withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { DriveForbiddenError, DriveNotFoundError } from "./errors.js";

export const driveWorkflowKinds = [
  "shortcut",
  "file_request",
  "approval",
  "ownership_transfer",
  "shared_drive",
  "classification",
  "hold",
  "investigation",
] as const;
export type DriveWorkflowKind = (typeof driveWorkflowKinds)[number];
export type DriveWorkflowState = "open" | "approved" | "rejected" | "cancelled" | "completed";

export interface DriveWorkflowRecord {
  readonly id: string;
  readonly kind: DriveWorkflowKind;
  readonly resourceType: "object" | "folder";
  readonly resourceId: string;
  readonly requestedByActorId: string;
  readonly assignedToActorId: string | null;
  readonly state: DriveWorkflowState;
  readonly version: string;
  readonly payload: JsonObject;
  readonly policySnapshot: JsonObject;
  readonly dueAt: Date | null;
  readonly decidedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DriveWorkflowStore {
  create(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly kind: DriveWorkflowKind;
    readonly resourceType: "object" | "folder";
    readonly resourceId: string;
    readonly assignedToActorId?: string;
    readonly payload: JsonObject;
    readonly dueAt?: Date;
    readonly allowSensitivityDowngrade?: boolean;
  }): Promise<DriveWorkflowRecord>;
  list(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly state?: DriveWorkflowState;
    readonly limit: number;
  }): Promise<readonly DriveWorkflowRecord[]>;
  transition(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly workflowId: string;
    readonly expectedVersion: string;
    readonly state: Exclude<DriveWorkflowState, "open">;
    readonly payload?: JsonObject;
  }): Promise<DriveWorkflowRecord>;
}

interface WorkflowRow {
  readonly id: string;
  readonly kind: DriveWorkflowKind;
  readonly resource_type: "object" | "folder";
  readonly resource_id: string;
  readonly requested_by_actor_id: string;
  readonly assigned_to_actor_id: string | null;
  readonly state: DriveWorkflowState;
  readonly version: string | number;
  readonly payload: JsonObject;
  readonly policy_snapshot: JsonObject;
  readonly due_at: Date | null;
  readonly decided_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresDriveWorkflowStore implements DriveWorkflowStore {
  constructor(private readonly sql: postgres.Sql) {}

  async create(input: Parameters<DriveWorkflowStore["create"]>[0]): Promise<DriveWorkflowRecord> {
    validateCreate(input);
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        await requireResourceAccess(tx, input, input.kind !== "shortcut");
        if (input.assignedToActorId !== undefined) {
          await requireActiveActor(tx, input.orgId, input.assignedToActorId);
          if (input.kind !== "ownership_transfer") {
            await requireResourceAccess(
              tx,
              { ...input, actorId: input.assignedToActorId },
              input.kind === "file_request",
            );
          }
        }
        const id = randomUUID();
        const immediate = ["shortcut", "shared_drive", "classification", "hold"].includes(
          input.kind,
        );
        const state: DriveWorkflowState = immediate ? "completed" : "open";
        const policies = await policySnapshot(tx, input.orgId);
        assertWorkflowPolicy(policies, input.kind, input.dueAt);
        if (input.kind === "classification") await applyClassification(tx, input, id);
        if (input.kind === "hold") await applyHold(tx, input);
        if (input.kind === "shared_drive") {
          const name = typeof input.payload.name === "string" ? input.payload.name : "";
          await tx`select helix_drive_create_shared_drive(
            ${input.orgId}, ${input.actorId}, ${id}, ${input.resourceId}, ${name}
          )`;
        }
        const rows = await tx<WorkflowRow[]>`
          insert into drive_workflows (
            id, org_id, kind, resource_type, resource_id, requested_by_actor_id,
            assigned_to_actor_id, state, payload, policy_snapshot, due_at, decided_at
          ) values (
            ${id}, ${input.orgId}, ${input.kind}, ${input.resourceType}, ${input.resourceId},
            ${input.actorId}, ${input.assignedToActorId ?? null}, ${state},
            ${tx.json(input.payload)}, ${tx.json(policies)}, ${input.dueAt ?? null},
            ${immediate ? new Date() : null}
          ) returning *
        `;
        await appendWorkflowEvent(tx, input.orgId, input.actorId, id, "created", {
          kind: input.kind,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          state,
        });
        return mapWorkflow(rows[0]);
      },
    );
  }

  async list(
    input: Parameters<DriveWorkflowStore["list"]>[0],
  ): Promise<readonly DriveWorkflowRecord[]> {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 250);
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) =>
        (
          await tx<WorkflowRow[]>`
            select * from drive_workflows
            where org_id = ${input.orgId}
              ${input.state === undefined ? tx`` : tx`and state = ${input.state}`}
            order by updated_at desc, id desc limit ${limit}
          `
        ).map(mapWorkflow),
    );
  }

  async transition(
    input: Parameters<DriveWorkflowStore["transition"]>[0],
  ): Promise<DriveWorkflowRecord> {
    if (!/^[1-9][0-9]{0,18}$/u.test(input.expectedVersion)) {
      throw new BadRequestError("Invalid Drive workflow version.");
    }
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        const currentRows = await tx<WorkflowRow[]>`
          select * from drive_workflows
          where org_id = ${input.orgId} and id = ${input.workflowId}
          for update
        `;
        const current = currentRows[0];
        if (current === undefined) throw new DriveNotFoundError("Drive workflow not found.");
        if (current.state !== "open" || String(current.version) !== input.expectedVersion) {
          throw new BadRequestError("Drive workflow changed; refresh and try again.");
        }
        assertTransition(current.kind, input.state);
        const requesterAction = input.state === "cancelled";
        const permittedActor = requesterAction
          ? current.requested_by_actor_id
          : current.assigned_to_actor_id;
        if (permittedActor !== input.actorId) {
          throw new DriveForbiddenError("Only the assigned actor can decide this Drive workflow.");
        }
        if (current.kind === "ownership_transfer" && input.state === "approved") {
          await tx`select helix_drive_apply_ownership_transfer(${input.orgId}, ${current.id})`;
        }
        if (current.kind === "file_request" && input.state === "completed") {
          await validateFileRequestResult(tx, input.orgId, current, input.payload);
        }
        const rows = await tx<WorkflowRow[]>`
          update drive_workflows set
            state = ${input.state}, decided_at = statement_timestamp(),
            payload = payload || ${tx.json(input.payload ?? {})}
          where org_id = ${input.orgId} and id = ${input.workflowId}
            and state = 'open' and version = ${input.expectedVersion}::bigint
          returning *
        `;
        await appendWorkflowEvent(tx, input.orgId, input.actorId, current.id, "transitioned", {
          from: "open",
          to: input.state,
          kind: current.kind,
        });
        return mapWorkflow(rows[0]);
      },
    );
  }
}

function validateCreate(input: Parameters<DriveWorkflowStore["create"]>[0]): void {
  if (
    ["file_request", "approval", "ownership_transfer", "investigation"].includes(input.kind) &&
    input.assignedToActorId === undefined
  ) {
    throw new BadRequestError(`${input.kind} requires an assigned actor.`);
  }
  if (input.kind === "ownership_transfer" && input.resourceType !== "object") {
    throw new BadRequestError("Ownership transfer requires a Drive object.");
  }
  if (["file_request", "shared_drive"].includes(input.kind) && input.resourceType !== "folder") {
    throw new BadRequestError(`${input.kind} requires a Drive folder.`);
  }
  if (input.dueAt !== undefined && input.dueAt.getTime() <= Date.now()) {
    throw new BadRequestError("Drive workflow due date must be in the future.");
  }
}

function assertTransition(
  kind: DriveWorkflowKind,
  state: Exclude<DriveWorkflowState, "open">,
): void {
  const decision = kind === "approval" || kind === "ownership_transfer";
  const completion = kind === "file_request" || kind === "investigation";
  if (
    state !== "cancelled" &&
    state !== "rejected" &&
    !((decision && state === "approved") || (completion && state === "completed"))
  ) {
    throw new BadRequestError(`Invalid ${kind} transition.`);
  }
}

async function requireActiveActor(
  tx: postgres.TransactionSql,
  orgId: string,
  actorId: string,
): Promise<void> {
  const rows = await tx`select id from actors
    where org_id = ${orgId} and id = ${actorId} and disabled_at is null`;
  if (rows[0] === undefined) throw new BadRequestError("Assigned Drive actor is unavailable.");
}

async function requireResourceAccess(
  tx: postgres.TransactionSql,
  input: Parameters<DriveWorkflowStore["create"]>[0],
  write: boolean,
): Promise<void> {
  const requiredRole =
    input.kind === "ownership_transfer" || input.kind === "shared_drive"
      ? "owner"
      : write && input.kind !== "file_request"
        ? "editor"
        : write
          ? "commenter"
          : "reader";
  const rows =
    input.resourceType === "object"
      ? await tx`
          select 1 from objects object where object.org_id = ${input.orgId}
            and object.id = ${input.resourceId} and object.deleted_at is null
            and case helix_drive_effective_role(
              ${input.orgId}, ${input.actorId}, 'object', object.id
            ) when 'owner' then 3 when 'editor' then 2 when 'commenter' then 1
              when 'reader' then 0 else -1 end >=
              case ${requiredRole} when 'owner' then 3 when 'editor' then 2
                when 'commenter' then 1 else 0 end`
      : await tx`
          select 1 from drive_folders folder where folder.org_id = ${input.orgId}
            and folder.id = ${input.resourceId} and folder.deleted_at is null
            and case helix_drive_effective_role(
              ${input.orgId}, ${input.actorId}, 'drive_folder', folder.id
            ) when 'owner' then 3 when 'editor' then 2 when 'commenter' then 1
              when 'reader' then 0 else -1 end >=
              case ${requiredRole} when 'owner' then 3 when 'editor' then 2
                when 'commenter' then 1 else 0 end`;
  if (rows[0] === undefined)
    throw new DriveForbiddenError("Drive workflow resource is unavailable.");
}

async function policySnapshot(tx: postgres.TransactionSql, orgId: string): Promise<JsonObject> {
  const rows = await tx<{ readonly policies: JsonObject }[]>`
    select coalesce(jsonb_object_agg(
      policy_type, jsonb_build_object('enabled', enabled, 'enforcement', enforcement, 'settings', settings)
    ), '{}') as policies
    from admin_security_policies where org_id = ${orgId}
      and policy_type in ('external_sharing', 'dlp', 'drive_workflows')
  `;
  return rows[0]?.policies ?? {};
}

function assertWorkflowPolicy(
  policies: JsonObject,
  kind: DriveWorkflowKind,
  dueAt: Date | undefined,
): void {
  const raw = policies.drive_workflows;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  const policy = raw as JsonObject;
  if (policy.enabled !== true) return;
  const settings = policy.settings;
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return;
  const allowed = (settings as JsonObject).allowedKinds;
  if (Array.isArray(allowed) && !allowed.includes(kind)) {
    throw new DriveForbiddenError("This Drive workflow is disabled by administrator policy.");
  }
  if ((settings as JsonObject).requireDueDate === true && dueAt === undefined) {
    throw new BadRequestError("Administrator policy requires a workflow due date.");
  }
}

async function applyClassification(
  tx: postgres.TransactionSql,
  input: Parameters<DriveWorkflowStore["create"]>[0],
  workflowId: string,
): Promise<void> {
  const classification = input.payload.classification;
  if (
    typeof classification !== "string" ||
    !["public", "standard", "confidential", "restricted"].includes(classification)
  ) {
    throw new BadRequestError("Invalid Drive classification.");
  }
  if (input.allowSensitivityDowngrade === true) {
    await tx`select set_config('helix.allow_sensitivity_downgrade', 'on', true)`;
  }
  await tx`
    insert into resource_classifications (
      org_id, resource_type, resource_id, classification, source, reason, actor_id
    ) values (
      ${input.orgId}, ${input.resourceType === "object" ? "drive.file" : "drive.folder"},
      ${input.resourceId}, ${classification}, 'explicit', ${`workflow:${workflowId}`}, ${input.actorId}
    ) on conflict (org_id, resource_type, resource_id) do update set
      classification = excluded.classification, source = excluded.source,
      reason = excluded.reason, actor_id = excluded.actor_id, updated_at = statement_timestamp()
  `;
}

async function applyHold(
  tx: postgres.TransactionSql,
  input: Parameters<DriveWorkflowStore["create"]>[0],
): Promise<void> {
  const reason = input.payload.reason;
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 2_000) {
    throw new BadRequestError("Drive hold requires a reason.");
  }
  await tx`
    insert into drive_retention_holds (
      org_id, resource_type, resource_id, reason, created_by_actor_id, expires_at
    ) values (
      ${input.orgId}, ${input.resourceType}, ${input.resourceId}, ${reason.trim()},
      ${input.actorId}, ${input.dueAt ?? null}
    ) on conflict (org_id, resource_type, resource_id) where released_at is null do update set
      reason = excluded.reason, expires_at = excluded.expires_at
  `;
}

async function validateFileRequestResult(
  tx: postgres.TransactionSql,
  orgId: string,
  workflow: WorkflowRow,
  payload: JsonObject | undefined,
): Promise<void> {
  const objectId = payload?.objectId;
  if (typeof objectId !== "string")
    throw new BadRequestError("File request completion needs objectId.");
  const rows = await tx`select id from objects where org_id = ${orgId} and id = ${objectId}::uuid
    and metadata->>'folderId' = ${workflow.resource_id}::text and deleted_at is null`;
  if (rows[0] === undefined)
    throw new BadRequestError("Requested file is not in the target folder.");
}

async function appendWorkflowEvent(
  tx: postgres.TransactionSql,
  orgId: string,
  actorId: string,
  workflowId: string,
  action: string,
  payload: JsonObject,
): Promise<void> {
  await tx`insert into activity (org_id, actor_id, verb, object_type, object_id, payload)
    values (${orgId}, ${actorId}, ${`drive.workflow.${action}`}, 'drive.workflow', ${workflowId}, ${tx.json(payload)})`;
  await tx`insert into outbox (subject, payload) values (
    ${`drive.workflow.${action}`}, ${tx.json({ orgId, actorId, workflowId, ...payload })}
  )`;
}

function mapWorkflow(row: WorkflowRow | undefined): DriveWorkflowRecord {
  if (row === undefined) throw new Error("Expected Drive workflow row.");
  return {
    id: row.id,
    kind: row.kind,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    requestedByActorId: row.requested_by_actor_id,
    assignedToActorId: row.assigned_to_actor_id,
    state: row.state,
    version: String(row.version),
    payload: row.payload,
    policySnapshot: row.policy_snapshot,
    dueAt: row.due_at,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
