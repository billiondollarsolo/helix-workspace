import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDriveWorkflowStore } from "../../platform/drive/workflows.js";
import { tenantAwarePostgresSql } from "../../platform/tenancy/postgres-roles.js";

describe.skipIf(process.env.DATABASE_URL === undefined)("tenant-isolated Drive workflows", () => {
  const admin = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const role = "helix_drive_workflow_test_app";
  const password = "helix_drive_workflow_test_password";
  const runtimeUrl = new URL(process.env.DATABASE_URL ?? "postgres://localhost/helix");
  runtimeUrl.username = role;
  runtimeUrl.password = password;
  const runtime = postgres(runtimeUrl.toString(), { prepare: false });
  const store = new PostgresDriveWorkflowStore(tenantAwarePostgresSql(runtime));
  const orgId = "f1600000-0000-4000-8000-000000000001";
  const otherOrgId = "f1600000-0000-4000-8000-000000000002";
  const ownerId = "f1600000-0000-4000-8000-000000000011";
  const reviewerId = "f1600000-0000-4000-8000-000000000012";
  const otherActorId = "f1600000-0000-4000-8000-000000000013";
  const objectId = "f1600000-0000-4000-8000-000000000021";

  async function cleanup() {
    await cleanupTestTenants(admin, [orgId, otherOrgId]);
  }

  beforeAll(async () => {
    const ready = await admin<{ readonly ready: boolean }[]>`
      select to_regclass('public.drive_workflows') is not null as ready
    `;
    if (ready[0]?.ready !== true) throw new Error("Run migration 0160 before this test.");
    await cleanup();
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.unsafe(
      `create role ${role} login inherit nosuperuser nobypassrls password '${password}'`,
    );
    await admin.unsafe(`grant helix_app to ${role}`);
    await admin`insert into orgs (id, slug, display_name) values
      (${orgId}, 'drive-workflow-test', 'Drive workflow test'),
      (${otherOrgId}, 'drive-workflow-other', 'Drive workflow other')`;
    await admin`insert into actors (id, org_id, type, display_name) values
      (${ownerId}, ${orgId}, 'user', 'Owner'),
      (${reviewerId}, ${orgId}, 'user', 'Reviewer'),
      (${otherActorId}, ${otherOrgId}, 'user', 'Other tenant')`;
    await admin`insert into objects (
      id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata
    ) values (
      ${objectId}, ${orgId}, ${ownerId}, 'file', 'drive/workflow/report', 'text/plain', 1,
      ${"a".repeat(64)}, ${admin.json({ name: "report.txt", status: "ready" })}
    )`;
    await admin`insert into permissions (
      org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
    ) values (${orgId}, ${reviewerId}, 'object', ${objectId}, 'reader', ${ownerId})`;
    await admin`insert into admin_security_policies (
      org_id, policy_type, enabled, enforcement, settings, updated_by
    ) values (
      ${orgId}, 'drive_workflows', true, 'required',
      ${admin.json({ allowedKinds: ["approval", "ownership_transfer"], requireDueDate: false })},
      ${ownerId}
    )`;
  });

  afterAll(async () => {
    await cleanup();
    await runtime.end();
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.end();
  });

  it("keeps approval, ownership, policy, audit, and other tenants in one atomic flow", async () => {
    const approval = await store.create({
      orgId,
      actorId: ownerId,
      kind: "approval",
      resourceType: "object",
      resourceId: objectId,
      assignedToActorId: reviewerId,
      payload: { reason: "Publish" },
    });
    await expect(
      store.list({ orgId: otherOrgId, actorId: otherActorId, limit: 100 }),
    ).resolves.toEqual([]);
    await expect(
      store.transition({
        orgId,
        actorId: reviewerId,
        workflowId: approval.id,
        expectedVersion: approval.version,
        state: "approved",
      }),
    ).resolves.toMatchObject({ state: "approved", version: "2" });

    const transfer = await store.create({
      orgId,
      actorId: ownerId,
      kind: "ownership_transfer",
      resourceType: "object",
      resourceId: objectId,
      assignedToActorId: reviewerId,
      payload: {},
    });
    await store.transition({
      orgId,
      actorId: reviewerId,
      workflowId: transfer.id,
      expectedVersion: transfer.version,
      state: "approved",
    });

    const [object] = await admin<{ readonly owner_actor_id: string }[]>`
      select owner_actor_id from objects where id = ${objectId}
    `;
    expect(object?.owner_actor_id).toBe(reviewerId);
    const [evidence] = await admin<{ readonly events: number; readonly emitted: number }[]>`
      select
        (select count(*)::int from activity where org_id = ${orgId}
          and verb like 'drive.workflow.%') as events,
        (select count(*)::int from outbox where payload->>'orgId' = ${orgId}) as emitted
    `;
    expect(evidence).toMatchObject({ events: 4, emitted: 4 });
  });
});
