import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantEnvelopeCipher } from "../secrets/envelope.js";
import { tenantAwarePostgresSql } from "../tenancy/postgres-roles.js";
import { PostgresMailProviderCredentials } from "./provider-credentials.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(databaseUrl === undefined)("encrypted mail provider credentials", () => {
  const sql = postgres(databaseUrl ?? "", { max: 2, prepare: false });
  const orgId = randomUUID(),
    otherOrgId = randomUUID(),
    providerId = randomUUID();
  const cipher = new TenantEnvelopeCipher("test-only-mail-secret-master-key-32-bytes");
  const credentials = new PostgresMailProviderCredentials(tenantAwarePostgresSql(sql), cipher);
  beforeAll(async () => {
    for (const id of [orgId, otherOrgId])
      await sql`insert into orgs(id, slug, display_name) values (${id}, ${id}, 'Credential test')`;
    await sql`insert into mail_outbound_providers(id, org_id, name, kind, secret_ref, webhook_secret_ref) values (${providerId}, ${orgId}, 'Test', 'smtp', 'old-sending', 'old-feedback')`;
  });
  afterAll(async () => {
    await sql`delete from mail_outbound_providers where org_id=${orgId}`;
    await sql`delete from orgs where id in (${orgId}, ${otherOrgId})`;
    await sql.end();
  });
  it("encrypts, binds tenant/provider/purpose, rotates and removes without reviving a Vault handle", async () => {
    expect(await credentials.write(orgId, providerId, "sending", " smtp-secret ")).toBe(true);
    expect(await credentials.read(orgId, providerId, "sending")).toBe(" smtp-secret ");
    expect(await credentials.read(otherOrgId, providerId, "sending")).toBeUndefined();
    expect(await credentials.write(otherOrgId, providerId, "sending", "attack")).toBe(false);
    const [row] =
      await sql`select credential_ciphertext, secret_ref from mail_outbound_providers where id=${providerId}`;
    expect(row?.credential_ciphertext).toMatch(/^helix\$1\$/u);
    expect(row?.credential_ciphertext).not.toContain("smtp-secret");
    expect(row?.secret_ref).toBeNull();
    expect(() =>
      cipher.open(orgId, `mail-feedback.${providerId}`, String(row?.credential_ciphertext)),
    ).toThrow();
    expect(() =>
      cipher.open(orgId, `mail-sending.${randomUUID()}`, String(row?.credential_ciphertext)),
    ).toThrow();
    await credentials.write(orgId, providerId, "feedback", "feedback-secret");
    expect(await credentials.status(orgId, providerId)).toEqual({ sending: true, feedback: true });
    await credentials.write(orgId, providerId, "sending", "rotated-secret");
    expect(await credentials.read(orgId, providerId, "sending")).toBe("rotated-secret");
    await credentials.write(orgId, providerId, "sending", null);
    expect(await credentials.status(orgId, providerId)).toEqual({ sending: false, feedback: true });
    expect(await credentials.read(orgId, providerId, "sending")).toBeUndefined();
  });
});
