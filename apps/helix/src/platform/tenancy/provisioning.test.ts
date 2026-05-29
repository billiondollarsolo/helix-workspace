import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresTenantProvisioningStore } from "./provisioning.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-05-24T00:00:00.000Z");

describe("PostgresTenantProvisioningStore", () => {
  it("starts durable tenant provisioning state for a signup org", async () => {
    const recording = createRecordingSql();
    const store = new PostgresTenantProvisioningStore(recording.sql);

    const record = await store.start({
      orgId,
      requestedOwnerEmail: "Owner@Example.COM",
      metadata: { source: "signup" },
    });

    expect(record).toMatchObject({
      orgId,
      status: "pending",
      requestedOwnerEmail: "owner@example.com",
      currentStep: "signup_received",
      completedSteps: [],
      attemptCount: 0,
      lastError: null,
      metadata: { source: "signup" },
    });
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("insert into tenant_provisioning_state");
    expect(recording.calls[0]?.text).toContain("on conflict (org_id) do update");
    expect(recording.calls[0]?.values).toContain(orgId);
    expect(recording.calls[0]?.values).toContain("owner@example.com");
  });

  it("claims pending and failed provisioning rows with row locks", async () => {
    const recording = createRecordingSql();
    const store = new PostgresTenantProvisioningStore(recording.sql);

    await store.claimPending({ limit: 3 });

    expect(recording.calls[0]?.text).toContain("status in ('pending', 'failed')");
    expect(recording.calls[0]?.text).toContain("for update skip locked");
    expect(recording.calls[0]?.text).toContain("attempt_count = attempt_count + 1");
    expect(recording.calls[0]?.values).toContain(3);
  });

  it("loads provisioning state by org id", async () => {
    const recording = createRecordingSql();
    const store = new PostgresTenantProvisioningStore(recording.sql);

    const record = await store.findByOrgId(orgId);

    expect(record).toMatchObject({ orgId, requestedOwnerEmail: "owner@example.com" });
    expect(recording.calls[0]?.text).toContain("from tenant_provisioning_state");
    expect(recording.calls[0]?.values).toContain(orgId);
  });

  it("marks records waiting for verification with completed steps", async () => {
    const recording = createRecordingSql();
    const store = new PostgresTenantProvisioningStore(recording.sql);

    await store.markWaitingForVerification({
      orgId,
      currentStep: "waiting_for_verification",
      completedSteps: ["object_store_prefix"],
    });

    expect(recording.calls[0]?.text).toContain("status = ?");
    expect(recording.calls[0]?.text).toContain("completed_steps = ?");
    expect(recording.calls[0]?.values).toContain("waiting_for_verification");
    expect(recording.calls[0]?.values).toContain("waiting_for_verification");
    expect(recording.calls[0]?.values).toContain(orgId);
  });

  it("marks records succeeded after email verification", async () => {
    const recording = createRecordingSql();
    const store = new PostgresTenantProvisioningStore(recording.sql);

    await store.markSucceeded({
      orgId,
      currentStep: "email_verified",
      completedSteps: ["initial_owner_actor_created", "email_verified"],
    });

    expect(recording.calls[0]?.text).toContain("completed_at = case when ?");
    expect(recording.calls[0]?.values).toContain("succeeded");
    expect(recording.calls[0]?.values).toContain(true);
  });
});

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSql(): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve([
      {
        org_id: orgId,
        status: "pending",
        requested_owner_email: "owner@example.com",
        current_step: "signup_received",
        completed_steps: [],
        attempt_count: 0,
        last_error: null,
        metadata: { source: "signup" },
        created_at: now,
        updated_at: now,
        completed_at: null,
      },
    ]);
  };
  return {
    sql: Object.assign(tag, {
      array: (value: unknown) => value,
      json: (value: unknown) => value,
    }) as unknown as postgres.Sql,
    calls,
  };
}
