import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { TenantEnvelopeCipher } from "../secrets/envelope.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresEdgeCertificateStore } from "./store.js";

/**
 * The stored certificate under the runtime database role: the key is sealed
 * at rest, one certificate per organization, and no organization can read
 * another's.
 */

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const skip =
  skipUnlessLiveDatabase("Edge certificate storage through the runtime database role") ||
  adminUrl === undefined ||
  appUrl === undefined;

describe.skipIf(skip)("PostgresEdgeCertificateStore", () => {
  const admin = postgres(adminUrl ?? "", { max: 1 });
  const app = tenantAwarePostgresSql(postgres(appUrl ?? "", { max: 2 }));
  const cipher = new TenantEnvelopeCipher("edge-certificate-store-test-master-secret");
  const store = new PostgresEdgeCertificateStore(app, cipher);
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const actorId = randomUUID();
  // Stands in for a key: the store seals and returns it without reading it.
  const keyPem = "-----BEGIN TEST KEY-----\nnot-a-real-key\n-----END TEST KEY-----\n";
  const summary = {
    subject: "workspace.example.test",
    issuer: "Test Issuing CA",
    names: ["workspace.example.test", "mail.example.test"],
    notBefore: "2026-10-01T00:00:00.000Z",
    notAfter: "2027-10-01T00:00:00.000Z",
    fingerprintSha256: "c".repeat(64),
  };
  const inOrg = <T>(id: string, work: () => Promise<T>) =>
    withTenantPostgresContext(app, { orgId: id }, work);

  beforeAll(async () => {
    for (const id of [orgId, otherOrgId]) {
      await admin`
        insert into orgs (id, slug, display_name, status, tier, region)
        values (${id}, ${`edge-${id.slice(0, 8)}`}, 'Edge certificate test', 'active', 'personal', 'default')
      `;
    }
    await admin`
      insert into actors (id, org_id, type, display_name)
      values (${actorId}, ${orgId}, 'user', 'Edge Admin')
    `;
  });

  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId, otherOrgId]);
    await Promise.all([admin.end(), app.end()]);
  });

  it("keeps one certificate per organization with its key sealed at rest", async () => {
    await expect(inOrg(orgId, () => store.get(orgId))).resolves.toBeNull();

    const stored = await inOrg(orgId, () =>
      store.save({ orgId, actorId, chainPem: "chain-1", keyPem, summary }),
    );
    expect(stored.summary).toEqual(summary);

    const [row] = await admin<{ key_ciphertext: string; updated_by_actor_id: string }[]>`
      select key_ciphertext, updated_by_actor_id from edge_tls_certificates where org_id = ${orgId}
    `;
    expect(row?.key_ciphertext).toMatch(/^helix\$1\$/u);
    expect(row?.key_ciphertext).not.toContain("not-a-real-key");
    expect(row?.updated_by_actor_id).toBe(actorId);
    await expect(inOrg(orgId, () => store.readBundle(orgId))).resolves.toEqual({
      chainPem: "chain-1",
      keyPem,
      fingerprintSha256: summary.fingerprintSha256,
    });

    const renewed = { ...summary, fingerprintSha256: "d".repeat(64) };
    await inOrg(orgId, () =>
      store.save({ orgId, actorId, chainPem: "chain-2", keyPem, summary: renewed }),
    );
    const rows = await admin`select 1 from edge_tls_certificates where org_id = ${orgId}`;
    expect(rows).toHaveLength(1);
    await expect(inOrg(orgId, () => store.get(orgId))).resolves.toMatchObject({
      summary: { fingerprintSha256: "d".repeat(64) },
    });
  });

  it("hides the certificate from another organization and from a missing tenant context", async () => {
    await expect(inOrg(otherOrgId, () => store.get(orgId))).resolves.toBeNull();
    await expect(inOrg(otherOrgId, () => store.readBundle(orgId))).resolves.toBeNull();
    await expect(inOrg(otherOrgId, () => store.clear(orgId))).resolves.toBeNull();
    await expect(
      inOrg(otherOrgId, () => store.save({ orgId, actorId, chainPem: "chain-x", keyPem, summary })),
    ).rejects.toThrow();
    await expect(store.get(orgId)).resolves.toBeNull();
  });

  it("removes the certificate and reports what was removed", async () => {
    await expect(inOrg(orgId, () => store.clear(orgId))).resolves.toMatchObject({
      summary: { subject: summary.subject },
    });
    await expect(inOrg(orgId, () => store.clear(orgId))).resolves.toBeNull();
    await expect(inOrg(orgId, () => store.readBundle(orgId))).resolves.toBeNull();
  });
});
