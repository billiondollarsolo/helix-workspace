import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { PendingActionRecord } from "./registry.js";
import { PostgresPendingActionStore } from "./pending-actions-postgres-store.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

describe("PostgresPendingActionStore", () => {
  it("persists requester identity, canonical hash, policy and safe preview", async () => {
    const database = createPendingActionsSql();
    const store = new PostgresPendingActionStore(database.sql);

    const created = await store.create(actionInput());

    expect(created).toMatchObject({
      requesterActorId: "actor-1",
      requesterCredentialId: "credential-1",
      approvalOwnerActorId: "owner-1",
      inputHash: "a".repeat(64),
      policyVersion: "7",
      status: "pending_confirmation",
      executionIdempotencyKey: "pending-action:pending-1",
    });
    expect(database.calls[0]?.text).toContain("requester_credential_id");
    expect(database.calls[0]?.text).toContain("input_hash");
    expect(database.calls[0]?.text).toContain("policy_snapshot");
    expect(database.calls[0]?.text).toContain("execution_idempotency_key");
  });

  it("uses compare-and-set so concurrent approvals and cancellation cannot both win", async () => {
    const database = createPendingActionsSql();
    const store = new PostgresPendingActionStore(database.sql);
    const created = await store.create(actionInput());
    const approvedAt = new Date("2026-07-28T12:01:00.000Z");

    const [first, second] = await Promise.all([
      store.approve({ id: created.id, approverActorId: "owner-1", approvedAt }),
      store.approve({ id: created.id, approverActorId: "admin-1", approvedAt }),
    ]);
    const cancelled = await store.cancel({
      id: created.id,
      actorId: "owner-1",
      cancelledAt: approvedAt,
    });

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(cancelled).toMatchObject({ status: "cancelled" });
    const approveSql = database.calls.find((call) => call.text.includes("status = 'approved'"));
    expect(approveSql?.text).toContain("and status = 'pending_confirmation'");
    expect(approveSql?.text).toContain("and expires_at >");
  });

  it("claims once and terminally fails an expired unknown outcome without re-execution", async () => {
    const database = createPendingActionsSql();
    const store = new PostgresPendingActionStore(database.sql);
    const created = await store.create(actionInput());
    const approvedAt = new Date("2026-07-28T12:01:00.000Z");
    await store.approve({ id: created.id, approverActorId: "owner-1", approvedAt });

    const first = await store.claimExecution({
      id: created.id,
      approverActorId: "owner-1",
      executionActorId: "actor-1",
      startedAt: new Date("2026-07-28T12:02:00.000Z"),
      leaseExpiresAt: new Date("2026-07-28T12:03:00.000Z"),
    });
    const concurrent = await store.claimExecution({
      id: created.id,
      approverActorId: "owner-1",
      executionActorId: "actor-1",
      startedAt: new Date("2026-07-28T12:02:30.000Z"),
      leaseExpiresAt: new Date("2026-07-28T12:03:30.000Z"),
    });
    const recovered = await store.recoverStaleExecutions({
      now: new Date("2026-07-28T12:03:01.000Z"),
    });
    const replay = await store.completeExecution({
      id: created.id,
      executionActorId: "actor-1",
      status: "executed",
      completedAt: new Date("2026-07-28T12:03:11.000Z"),
      result: { ok: true },
    });

    expect(first).toMatchObject({ status: "executing", executionAttempts: 1 });
    expect(concurrent).toBeNull();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: "failed",
      error: "execution_outcome_unknown",
      executionAttempts: 1,
    });
    expect(replay).toBeNull();
    const claimSql = database.calls.find((call) =>
      call.text.includes("execution_attempts = execution_attempts + 1"),
    );
    expect(claimSql?.text).toContain("status = 'approved'");
    const recoverySql = database.calls.find((call) =>
      call.text.includes("execution_outcome_unknown"),
    );
    expect(recoverySql?.text).toContain("for update skip locked");
  });
});

function actionInput() {
  return {
    id: "pending-1",
    orgId: "org-1",
    actorId: "actor-1",
    requesterActorId: "actor-1",
    requesterCredentialId: "credential-1",
    requesterPrincipal: {
      id: "actor-1",
      orgId: "org-1",
      type: "agent" as const,
      scopes: ["workspace.write"],
    },
    requesterIp: "192.0.2.10",
    approvalOwnerActorId: "owner-1",
    toolId: "workspace.write",
    input: { objectId: "object-1", value: true },
    inputHash: "a".repeat(64),
    policySnapshot: { schemaVersion: "1", credentialPolicyVersion: "7" },
    policyVersion: "7",
    preview: {
      toolId: "workspace.write",
      action: "workspace.write",
      resourceIds: ["object-1"],
      recipients: [],
      targets: [],
      consequence: "Change workspace data using workspace.write.",
    },
    createdAt: new Date("2026-07-28T12:00:00.000Z"),
    expiresAt: new Date("2026-07-28T12:10:00.000Z"),
    executionIdempotencyKey: "pending-action:pending-1",
    traceId: "trace-1",
  };
}

function createPendingActionsSql(): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  let row: PendingActionRecord | null = null;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("$");
    calls.push({ text, values });
    if (text.includes("insert into pending_actions")) {
      const input = actionInput();
      row = {
        ...input,
        status: "pending_confirmation",
        approverActorId: null,
        executionActorId: null,
        decidedAt: null,
        approvedAt: null,
        executionStartedAt: null,
        executionCompletedAt: null,
        executionLeaseExpiresAt: null,
        executionAttempts: 0,
        result: null,
        error: null,
      };
      return Promise.resolve([toRow(row)]);
    }
    if (text.includes("approver_actor_id =") && !text.includes("execution_attempts =")) {
      if (row === null || row.status !== "pending_confirmation") return Promise.resolve([]);
      row = {
        ...row,
        status: "approved",
        approverActorId: values[0] as string,
        approvedAt: values[1] as Date,
        decidedAt: values[1] as Date,
      };
      return Promise.resolve([toRow(row)]);
    }
    if (text.includes("status = 'cancelled'")) {
      if (row === null || (row.status !== "pending_confirmation" && row.status !== "approved")) {
        return Promise.resolve([]);
      }
      row = { ...row, status: "cancelled", decidedAt: values[0] as Date };
      return Promise.resolve([toRow(row)]);
    }
    if (text.includes("execution_attempts = execution_attempts + 1")) {
      const startedAt = values[1] as Date;
      if (row === null || row.status !== "approved") {
        return Promise.resolve([]);
      }
      row = {
        ...row,
        status: "executing",
        executionActorId: values[0] as string,
        executionStartedAt: startedAt,
        executionLeaseExpiresAt: values[2] as Date,
        executionAttempts: row.executionAttempts + 1,
      };
      return Promise.resolve([toRow(row)]);
    }
    if (text.includes("execution_outcome_unknown")) {
      const now = values[0] as Date;
      if (
        row === null ||
        row.status !== "executing" ||
        row.executionLeaseExpiresAt === null ||
        row.executionLeaseExpiresAt > now
      ) {
        return Promise.resolve([]);
      }
      row = {
        ...row,
        status: "failed",
        error: "execution_outcome_unknown",
        executionCompletedAt: now,
        executionLeaseExpiresAt: null,
      };
      return Promise.resolve([toRow(row)]);
    }
    if (text.includes("execution_completed_at =")) {
      if (row === null || row.status !== "executing") return Promise.resolve([]);
      row = {
        ...row,
        status: values[0] as "executed" | "failed",
        executionCompletedAt: values[1] as Date,
        executionLeaseExpiresAt: null,
        result: (values[3] as PendingActionRecord["result"]) ?? null,
        error: (values[4] as string | null) ?? null,
      };
      return Promise.resolve([toRow(row)]);
    }
    if (text.includes("from pending_actions")) {
      return Promise.resolve(row === null ? [] : [toRow(row)]);
    }
    return Promise.resolve([]);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    unsafe: (value: string) => value,
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

function toRow(record: PendingActionRecord): Record<string, unknown> {
  return {
    id: record.id,
    org_id: record.orgId,
    actor_id: record.requesterActorId,
    requester_credential_id: record.requesterCredentialId,
    requester_principal: record.requesterPrincipal,
    requester_ip: record.requesterIp,
    approval_owner_actor_id: record.approvalOwnerActorId,
    approver_actor_id: record.approverActorId,
    execution_actor_id: record.executionActorId,
    tool_id: record.toolId,
    input: record.input,
    input_hash: record.inputHash,
    policy_snapshot: record.policySnapshot,
    policy_version: record.policyVersion,
    preview: record.preview,
    status: record.status,
    expires_at: record.expiresAt,
    created_at: record.createdAt,
    decided_at: record.decidedAt,
    approved_at: record.approvedAt,
    execution_started_at: record.executionStartedAt,
    execution_completed_at: record.executionCompletedAt,
    execution_lease_expires_at: record.executionLeaseExpiresAt,
    execution_attempts: record.executionAttempts,
    execution_idempotency_key: record.executionIdempotencyKey,
    trace_id: record.traceId,
    result: record.result,
    error: record.error,
  };
}
