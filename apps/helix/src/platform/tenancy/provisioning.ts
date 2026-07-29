import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";

export type TenantProvisioningStatus =
  "pending" | "running" | "waiting_for_verification" | "succeeded" | "failed";

export interface TenantProvisioningRecord {
  readonly orgId: string;
  readonly status: TenantProvisioningStatus;
  readonly requestedOwnerEmail: string;
  readonly currentStep: string;
  readonly completedSteps: readonly string[];
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly metadata: JsonObject;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export interface StartTenantProvisioningInput {
  readonly orgId: string;
  readonly requestedOwnerEmail: string;
  readonly currentStep?: string;
  readonly metadata?: JsonObject;
}

export interface TenantProvisioningStore {
  start(input: StartTenantProvisioningInput): Promise<TenantProvisioningRecord>;
  findByOrgId(orgId: string): Promise<TenantProvisioningRecord | null>;
  claimPending(input?: { readonly limit?: number }): Promise<readonly TenantProvisioningRecord[]>;
  markWaitingForVerification(input: {
    readonly orgId: string;
    readonly currentStep: string;
    readonly completedSteps: readonly string[];
  }): Promise<TenantProvisioningRecord>;
  markFailed(input: {
    readonly orgId: string;
    readonly currentStep: string;
    readonly completedSteps: readonly string[];
    readonly error: string;
  }): Promise<TenantProvisioningRecord>;
  markSucceeded(input: {
    readonly orgId: string;
    readonly currentStep: string;
    readonly completedSteps: readonly string[];
  }): Promise<TenantProvisioningRecord>;
}

interface TenantProvisioningRow {
  readonly org_id: string;
  readonly status: TenantProvisioningStatus;
  readonly requested_owner_email: string;
  readonly current_step: string;
  readonly completed_steps: readonly string[];
  readonly attempt_count: number;
  readonly last_error: string | null;
  readonly metadata: JsonObject;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly completed_at: Date | null;
}

export class PostgresTenantProvisioningStore implements TenantProvisioningStore {
  constructor(private readonly sql: postgres.Sql) {}

  async start(input: StartTenantProvisioningInput): Promise<TenantProvisioningRecord> {
    const rows = (await this.sql`
      insert into tenant_provisioning_state (
        org_id,
        status,
        requested_owner_email,
        current_step,
        metadata
      )
      values (
        ${input.orgId},
        'pending',
        ${input.requestedOwnerEmail.toLowerCase()},
        ${input.currentStep ?? "signup_received"},
        ${this.sql.json(input.metadata ?? {})}
      )
      on conflict (org_id) do update
        set
          requested_owner_email = excluded.requested_owner_email,
          current_step = excluded.current_step,
          metadata = excluded.metadata,
          updated_at = now()
      returning
        org_id,
        status,
        requested_owner_email,
        current_step,
        completed_steps,
        attempt_count,
        last_error,
        metadata,
        created_at,
        updated_at,
        completed_at
    `) as unknown as readonly TenantProvisioningRow[];
    return mapTenantProvisioningRow(rows[0]);
  }

  async claimPending(
    input: { readonly limit?: number } = {},
  ): Promise<readonly TenantProvisioningRecord[]> {
    const limit = input.limit ?? 25;
    const rows = (await this.sql`
      update tenant_provisioning_state
      set
        status = 'running',
        attempt_count = attempt_count + 1,
        current_step = 'claimed',
        last_error = null,
        updated_at = now()
      where org_id in (
        select org_id
        from tenant_provisioning_state
        where status in ('pending', 'failed')
        order by updated_at asc
        limit ${limit}
        for update skip locked
      )
      returning
        org_id,
        status,
        requested_owner_email,
        current_step,
        completed_steps,
        attempt_count,
        last_error,
        metadata,
        created_at,
        updated_at,
        completed_at
    `) as unknown as readonly TenantProvisioningRow[];
    return rows.map(mapTenantProvisioningRow);
  }

  async findByOrgId(orgId: string): Promise<TenantProvisioningRecord | null> {
    const rows = (await this.sql`
      select
        org_id,
        status,
        requested_owner_email,
        current_step,
        completed_steps,
        attempt_count,
        last_error,
        metadata,
        created_at,
        updated_at,
        completed_at
      from tenant_provisioning_state
      where org_id = ${orgId}
      limit 1
    `) as unknown as readonly TenantProvisioningRow[];
    return rows[0] === undefined ? null : mapTenantProvisioningRow(rows[0]);
  }

  async markWaitingForVerification(input: {
    readonly orgId: string;
    readonly currentStep: string;
    readonly completedSteps: readonly string[];
  }): Promise<TenantProvisioningRecord> {
    return this.updateTerminalState({
      orgId: input.orgId,
      status: "waiting_for_verification",
      currentStep: input.currentStep,
      completedSteps: input.completedSteps,
      lastError: null,
    });
  }

  async markFailed(input: {
    readonly orgId: string;
    readonly currentStep: string;
    readonly completedSteps: readonly string[];
    readonly error: string;
  }): Promise<TenantProvisioningRecord> {
    return this.updateTerminalState({
      orgId: input.orgId,
      status: "failed",
      currentStep: input.currentStep,
      completedSteps: input.completedSteps,
      lastError: input.error,
    });
  }

  async markSucceeded(input: {
    readonly orgId: string;
    readonly currentStep: string;
    readonly completedSteps: readonly string[];
  }): Promise<TenantProvisioningRecord> {
    return this.updateTerminalState({
      orgId: input.orgId,
      status: "succeeded",
      currentStep: input.currentStep,
      completedSteps: input.completedSteps,
      lastError: null,
    });
  }

  private async updateTerminalState(input: {
    readonly orgId: string;
    readonly status: TenantProvisioningStatus;
    readonly currentStep: string;
    readonly completedSteps: readonly string[];
    readonly lastError: string | null;
  }): Promise<TenantProvisioningRecord> {
    const rows = (await this.sql`
      update tenant_provisioning_state
      set
        status = ${input.status},
        current_step = ${input.currentStep},
        completed_steps = ${this.sql.array([...input.completedSteps])},
        last_error = ${input.lastError},
        completed_at = case when ${input.status === "succeeded"} then now() else completed_at end,
        updated_at = now()
      where org_id = ${input.orgId}
      returning
        org_id,
        status,
        requested_owner_email,
        current_step,
        completed_steps,
        attempt_count,
        last_error,
        metadata,
        created_at,
        updated_at,
        completed_at
    `) as unknown as readonly TenantProvisioningRow[];
    return mapTenantProvisioningRow(rows[0]);
  }
}

function mapTenantProvisioningRow(
  row: TenantProvisioningRow | undefined,
): TenantProvisioningRecord {
  if (row === undefined) {
    throw new Error("tenant provisioning query returned no rows");
  }
  return {
    orgId: row.org_id,
    status: row.status,
    requestedOwnerEmail: row.requested_owner_email,
    currentStep: row.current_step,
    completedSteps: row.completed_steps,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}
