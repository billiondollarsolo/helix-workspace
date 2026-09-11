import type { Actor } from "@helix/sdk-types";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresRestoreJobStore } from "./restore-jobs.js";

const databaseUrl = process.env.DATABASE_URL;
const runtimeUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const orgId = "b7600000-0000-4000-8000-000000000010";
const requester: Actor = {
  id: "b7600000-0000-4000-8000-000000000011",
  orgId,
  type: "user",
  scopes: ["admin.backups.restore"],
};
const approver: Actor = { ...requester, id: "b7600000-0000-4000-8000-000000000012" };
const second: Actor = { ...requester, id: "b7600000-0000-4000-8000-000000000013" };

describe.skipIf(!databaseUrl || !runtimeUrl)("durable restore approval policy", () => {
  let admin: postgres.Sql, sql: postgres.Sql, store: PostgresRestoreJobStore;
  beforeAll(async () => {
    admin = postgres(databaseUrl ?? "");
    sql = tenantAwarePostgresSql(postgres(runtimeUrl ?? "", { prepare: false }));
    await cleanupTestTenants(admin, [orgId]);
    await admin`insert into orgs (id,slug,display_name) values (${orgId}, 'restore-policy-fixture', 'Restore policy')`;
    for (const [index, actor] of [requester, approver, second].entries())
      await admin`insert into actors (id,org_id,type,email,display_name,scopes) values (${actor.id},${orgId},'user',${`restore${String(index)}@policy.test`},'Restore actor','{admin.backups.restore}')`;
    store = new PostgresRestoreJobStore(sql);
  });
  afterAll(async () => {
    await admin`delete from backup_restore_job_approvals where org_id=${orgId}`;
    await admin`delete from backup_restore_jobs where org_id=${orgId}`;
    await cleanupTestTenants(admin, [orgId]);
    await Promise.all([admin.end(), sql.end()]);
  });

  it.each([0, 1, 2] as const)(
    "persists %i required approvals without fabricating approvals",
    async (requiredApprovals) => {
      const unique = randomUUID().replaceAll("-", "");
      const id = randomUUID();
      const input = {
        backupId: `test-${unique}`,
        encrypted: false,
        targetDatabase: `helix_restore_${unique}`,
        targetObjectBucket: `helix-restore-${unique}`,
        idempotencyKey: unique,
        requiredApprovals,
      };
      await withTenantPostgresContext(sql, { orgId, actorId: requester.id }, async () => {
        const job = await store.createJob(id, requester, input);
        expect(job).toMatchObject({
          requiredApprovals,
          approvalCount: 0,
          status: requiredApprovals === 0 ? "queued" : "pending_approval",
        });
        // Changing policy cannot replay the same request to release an older pending job.
        expect(
          await store.createJob(randomUUID(), requester, { ...input, requiredApprovals: 0 }),
        ).toMatchObject({ id, requiredApprovals });
        expect(await store.getJob(id, randomUUID())).toBeUndefined();
      });
      if (requiredApprovals === 0) return;
      await expect(
        withTenantPostgresContext(sql, { orgId, actorId: requester.id }, () =>
          store.approveJob(id, approver),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        withTenantPostgresContext(sql, { orgId, actorId: requester.id }, () =>
          store.approveJob(id, requester),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await withTenantPostgresContext(sql, { orgId, actorId: approver.id }, async () => {
        expect(await store.approveJob(id, approver)).toMatchObject({
          approvalCount: 1,
          status: requiredApprovals === 1 ? "queued" : "pending_approval",
        });
        expect(await store.approveJob(id, approver)).toMatchObject({ approvalCount: 1 });
      });
      if (requiredApprovals === 2)
        await withTenantPostgresContext(sql, { orgId, actorId: second.id }, async () => {
          expect(await store.approveJob(id, second)).toMatchObject({
            approvalCount: 2,
            status: "queued",
          });
        });
    },
  );
});
