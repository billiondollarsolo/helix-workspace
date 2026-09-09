import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { BadRequestError } from "../../api/api-error.js";
import { DriveForbiddenError } from "./errors.js";
import { PostgresDriveWorkflowStore } from "./workflows.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const assigneeId = "33333333-3333-4333-8333-333333333333";
const objectId = "44444444-4444-4444-8444-444444444444";
const workflowId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-09-03T12:00:00.000Z");

describe("PostgresDriveWorkflowStore", () => {
  it("rejects incomplete and impossible workflows before writing", async () => {
    const recording = recordingSql();
    const store = new PostgresDriveWorkflowStore(recording.sql);

    await expect(
      store.create({
        orgId,
        actorId: ownerId,
        kind: "file_request",
        resourceType: "folder",
        resourceId: objectId,
        payload: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      store.create({
        orgId,
        actorId: ownerId,
        kind: "ownership_transfer",
        resourceType: "folder",
        resourceId: objectId,
        assignedToActorId: assigneeId,
        payload: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(recording.calls).toEqual([]);
  });

  it("enforces the snapshotted admin workflow allowlist", async () => {
    const recording = recordingSql({
      policies: {
        drive_workflows: {
          enabled: true,
          settings: { allowedKinds: ["shortcut"], requireDueDate: false },
        },
      },
    });
    const store = new PostgresDriveWorkflowStore(recording.sql);

    await expect(
      store.create({
        orgId,
        actorId: ownerId,
        kind: "approval",
        resourceType: "object",
        resourceId: objectId,
        assignedToActorId: assigneeId,
        payload: {},
      }),
    ).rejects.toBeInstanceOf(DriveForbiddenError);
    expect(recording.calls.some((call) => call.text.includes("insert into drive_workflows"))).toBe(
      false,
    );
  });

  it("applies classification and emits the shared workflow audit/outbox event atomically", async () => {
    const recording = recordingSql();
    const store = new PostgresDriveWorkflowStore(recording.sql);

    await expect(
      store.create({
        orgId,
        actorId: ownerId,
        kind: "classification",
        resourceType: "object",
        resourceId: objectId,
        payload: { classification: "restricted" },
      }),
    ).resolves.toMatchObject({ kind: "classification", state: "completed", version: "1" });
    expect(recording.calls.some((call) => call.text.includes("resource_classifications"))).toBe(
      true,
    );
    expect(recording.calls.some((call) => call.text.includes("insert into activity"))).toBe(true);
    expect(recording.calls.some((call) => call.text.includes("insert into outbox"))).toBe(true);
  });

  it("opens the atomic downgrade gate only for an authorized request", async () => {
    const recording = recordingSql();
    const store = new PostgresDriveWorkflowStore(recording.sql);
    await store.create({
      orgId,
      actorId: ownerId,
      kind: "classification",
      resourceType: "object",
      resourceId: objectId,
      payload: { classification: "public" },
      allowSensitivityDowngrade: true,
    });
    expect(recording.calls.some((call) => call.text.includes("allow_sensitivity_downgrade"))).toBe(
      true,
    );
  });

  it("rejects kind-incompatible terminal transitions without updating", async () => {
    const recording = recordingSql({ current: workflowRow() });
    const store = new PostgresDriveWorkflowStore(recording.sql);

    await expect(
      store.transition({
        orgId,
        actorId: assigneeId,
        workflowId,
        expectedVersion: "1",
        state: "completed",
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(recording.calls.some((call) => call.text.includes("update drive_workflows set"))).toBe(
      false,
    );
  });
});

interface RecordingOptions {
  readonly policies?: Record<string, unknown>;
  readonly current?: ReturnType<typeof workflowRow>;
}

function recordingSql(options: RecordingOptions = {}) {
  const calls: Array<{ readonly text: string; readonly values: readonly unknown[] }> = [];
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      calls.push({ text, values });
      if (text.includes("select * from drive_workflows")) {
        return Promise.resolve(options.current === undefined ? [] : [options.current]);
      }
      if (text.includes("from objects object") || text.includes("from drive_folders folder")) {
        return Promise.resolve([{ found: true }]);
      }
      if (text.includes("from actors")) return Promise.resolve([{ id: assigneeId }]);
      if (text.includes("from admin_security_policies")) {
        return Promise.resolve([{ policies: options.policies ?? {} }]);
      }
      if (text.includes("insert into drive_workflows"))
        return Promise.resolve([
          workflowRow({
            kind: "classification",
            state: "completed",
            assigned_to_actor_id: null,
            decided_at: now,
          }),
        ]);
      return Promise.resolve([]);
    },
    {
      json: (value: unknown) => value,
      begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
        callback(sql as unknown as postgres.TransactionSql),
    },
  ) as unknown as postgres.Sql;
  return { sql, calls };
}

function workflowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: workflowId,
    kind: "approval",
    resource_type: "object",
    resource_id: objectId,
    requested_by_actor_id: ownerId,
    assigned_to_actor_id: assigneeId,
    state: "open",
    version: 1,
    payload: {},
    policy_snapshot: {},
    due_at: null,
    decided_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}
