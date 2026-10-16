import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { cleanupTestTenants } from "../../../test-support/cleanup-tenants.js";
import { listMailThreads } from "../store-thread-list.js";
import { MailDraftStore } from "../store-drafts.js";
import { MailProductivityStore } from "./store.js";
const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
describe.skipIf(!adminUrl || !appUrl)("mail productivity with runtime RLS", () => {
  let admin: postgres.Sql, app: postgres.Sql;
  const orgId = randomUUID();
  const owner: Actor = {
    id: randomUUID(),
    orgId,
    type: "user",
    scopes: ["mail.read", "mail.write"],
  };
  const as = <T>(actor: Actor, fn: () => Promise<T>) =>
    withTenantPostgresContext(app, { orgId: actor.orgId, actorId: actor.id }, fn);
  beforeAll(async () => {
    assert(adminUrl && appUrl);
    admin = postgres(adminUrl, { max: 2, prepare: false });
    app = tenantAwarePostgresSql(postgres(appUrl, { max: 2, prepare: false }));
    await admin`insert into orgs(id,slug,display_name,status) values(${orgId},${orgId},'Mail regression','active')`;
    await admin`insert into actors(id,org_id,type,display_name,scopes) values(${owner.id},${orgId},'user','Mail test',${admin.array([...(owner.scopes ?? [])])})`;
  });
  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId]);
    await Promise.all([app.end(), admin.end()]);
  });
  it("uses valid delivery lifecycle states when listing mail and checking follow-ups", async () => {
    for (const query of ["", "is:needs-reply", "is:waiting-on"]) {
      await expect(
        as(owner, () =>
          listMailThreads(app, new MailDraftStore(app), { orgId, actorId: owner.id, query }),
        ),
      ).resolves.toMatchObject({ threads: [] });
    }
    await expect(
      as(owner, () =>
        new MailProductivityStore(app).followUp(owner, {
          threadId: randomUUID(),
          messageId: randomUUID(),
          state: "done",
        }),
      ),
    ).rejects.toThrow("Conversation changed");
  });
  it("allows worker discovery only outside tenant request contexts", async () => {
    await expect(app`select * from helix_mail_productivity_work(1)`).resolves.toBeDefined();
    await expect(
      as(owner, () => app`select * from helix_mail_productivity_work(1)`),
    ).rejects.toThrow("restricted to the worker");
    await expect(
      as(owner, () => app`select * from helix_meet_transcript_work_orgs(1)`),
    ).rejects.toThrow();
  });
});
