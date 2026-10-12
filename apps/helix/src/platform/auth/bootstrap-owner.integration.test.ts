import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { tenantAwarePostgresSql } from "../tenancy/postgres-roles.js";
import { PostgresAdminUserInviteStore } from "./admin-user-invites.js";
import { bootstrapWorkspaceOwner } from "./bootstrap-owner.js";
import { WORKSPACE_ADMIN_SCOPES, WORKSPACE_MEMBER_SCOPES } from "./member-scopes.js";

const live = !skipUnlessLiveDatabase("first workspace owner bootstrap");
describe.skipIf(!live)("first workspace owner bootstrap", () => {
  const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 1 });
  const sql = tenantAwarePostgresSql(
    postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 4 }),
  );
  const orgId = randomUUID();
  const domain = `${randomUUID()}.owner.test`;
  const email = `owner@${domain}`;
  const input = { orgId, email, displayName: "Pat Owner", publicBaseUrl: "https://helix.example" };
  const tokenOf = (inviteUrl: string) => new URL(inviteUrl).searchParams.get("token") ?? "";

  beforeAll(async () => {
    await admin`
      insert into orgs (id, slug, display_name, status) values (${orgId}, ${orgId}, 'Owner Co', 'active')
    `;
  });

  afterAll(async () => {
    await admin`delete from "user" where lower(email) like ${`%@${domain}`}`;
    await cleanupTestTenants(admin, [orgId]);
    await admin`delete from identity_subjects where canonical_email like ${`%@${domain}`}`;
    await Promise.all([admin.end(), sql.end()]);
  });

  it("refuses a workspace that does not exist yet", async () => {
    await expect(bootstrapWorkspaceOwner(sql, { ...input, orgId: randomUUID() })).resolves.toEqual({
      status: "workspace_missing",
    });
  });

  it("creates a full administrator with a single-use set-password link", async () => {
    const first = await bootstrapWorkspaceOwner(sql, input);
    if (first.status !== "invited") throw new Error(`unexpected status ${first.status}`);
    expect(
      first.inviteUrl.startsWith("https://helix.example/signup/invite?token=helix_invite_"),
    ).toBe(true);
    const [owner] = await admin<{ scopes: string[]; display_name: string }[]>`
      select scopes, display_name from actors where id = ${first.actorId}
    `;
    expect(owner?.display_name).toBe("Pat Owner");
    for (const scope of [...WORKSPACE_MEMBER_SCOPES, ...WORKSPACE_ADMIN_SCOPES]) {
      expect(owner?.scopes).toContain(scope);
    }

    // Running it again before the owner joins replaces the link.
    const second = await bootstrapWorkspaceOwner(sql, input);
    if (second.status !== "invited") throw new Error(`unexpected status ${second.status}`);
    expect(second.actorId).toBe(first.actorId);
    const invites = new PostgresAdminUserInviteStore(sql);
    await expect(invites.inspect(orgId, tokenOf(first.inviteUrl))).resolves.toBeNull();
    await expect(invites.inspect(orgId, tokenOf(second.inviteUrl))).resolves.toMatchObject({
      email,
    });

    // After the owner chooses a password there is nothing left to bootstrap.
    await expect(
      invites.accept(orgId, {
        token: tokenOf(second.inviteUrl),
        passwordHash: await hashPassword("correct horse battery staple"),
      }),
    ).resolves.toMatchObject({ status: "accepted", actorId: first.actorId });
    await expect(bootstrapWorkspaceOwner(sql, input)).resolves.toEqual({
      status: "already_joined",
      actorId: first.actorId,
    });

    const audit = await admin<{ verb: string }[]>`
      select distinct verb from activity where org_id = ${orgId} and object_id = ${first.actorId}
    `;
    expect(audit.map((row) => row.verb)).toEqual(
      expect.arrayContaining(["identity.owner.bootstrapped", "identity.user.invite_accepted"]),
    );
  });
});
