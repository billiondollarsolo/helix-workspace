import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPassword } from "better-auth/crypto";
import postgres from "postgres";
import { describe, it, expect } from "vitest";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { tenantAwarePostgresSql } from "../tenancy/postgres-roles.js";
import {
  bootstrapAdmin,
  bootstrapPassword,
  bootstrapPasswordChangeRequired,
} from "./bootstrap-admin.js";

describe.skipIf(skipUnlessLiveDatabase("configured administrator bootstrap"))(
  "configured administrator bootstrap",
  () => {
    it("serializes first boot, preserves credentials on restart and retires old invitation tokens", async () => {
      const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "");
      const sql = tenantAwarePostgresSql(postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? ""));
      const orgId = randomUUID();
      const email = `owner@${orgId}.test`;
      const directory = await mkdtemp(join(tmpdir(), "helix-bootstrap-"));
      try {
        await admin`insert into orgs(id,slug,display_name,status) values(${orgId},${orgId},'Bootstrap','active')`;
        const env = {
          HELIX_BOOTSTRAP_ADMIN_ENABLED: "true",
          HELIX_BOOTSTRAP_ADMIN_EMAIL: email,
          HELIX_BOOTSTRAP_ADMIN_STATE_DIRECTORY: directory,
        };
        await Promise.all([
          bootstrapAdmin(sql, orgId, "https://workspace.example", env),
          bootstrapAdmin(sql, orgId, "https://workspace.example", env),
        ]);
        const [account] = await admin<
          { id: string; password: string }[]
        >`select u.id,a.password from "user" u join account a on a."userId"=u.id where u.email=${email}`;
        expect(account).toBeDefined();
        if (account === undefined) throw new Error("Bootstrap account missing");
        const file = join(directory, "bootstrap-admin.password");
        const password = (await readFile(file, "utf8")).trim();
        expect(await verifyPassword({ password, hash: account.password })).toBe(true);
        expect(await bootstrapPasswordChangeRequired(sql, orgId, account.id)).toBe(true);
        await bootstrapAdmin(sql, orgId, "https://workspace.example", {
          ...env,
          HELIX_BOOTSTRAP_ADMIN_EMAIL: "changed@example.test",
          HELIX_BOOTSTRAP_ADMIN_PASSWORD_FILE: "/missing",
        });
        expect((await readFile(file, "utf8")).trim()).toBe(password);
        const [invites] = await admin<
          { n: number }[]
        >`select count(*)::int n from signup_onboarding_invites where org_id=${orgId} and expires_at>now() and accepted_at is null`;
        expect(invites?.n).toBe(0);
        await admin`update account set password='new password hash' where "userId"=${account.id} and "providerId"='credential'`;
        expect(await bootstrapPasswordChangeRequired(sql, orgId, account.id)).toBe(false);
        expect(
          (await admin`select 1 from actors where org_id=${orgId} and type='user'`).length,
        ).toBe(1);
        await admin`delete from installation_admin_bootstrap where org_id=${orgId}`;
        await admin`delete from "user" where id=${account.id}`;
      } finally {
        await cleanupTestTenants(admin, [orgId]);
        await Promise.all([admin.end(), sql.end()]);
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);

describe("bootstrap password files", () => {
  it("accepts private files and rejects public files, links and invalid passwords", async () => {
    const directory = await mkdtemp(join(tmpdir(), "helix-bootstrap-file-"));
    const file = join(directory, "password");
    try {
      await writeFile(file, "correct password\n", { mode: 0o600 });
      expect(bootstrapPassword(file)).toBe("correct password");
      await chmod(file, 0o644);
      expect(() => bootstrapPassword(file)).toThrow();
      await chmod(file, 0o600);
      await symlink(file, join(directory, "link"));
      expect(() => bootstrapPassword(join(directory, "link"))).toThrow();
      await writeFile(file, "short");
      expect(() => bootstrapPassword(file)).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
