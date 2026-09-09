import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAgentCredentialStore } from "../../platform/auth/postgres-store.js";
import { authenticateApiKey, hashApiKey } from "../../platform/auth/credentials.js";
import { hashSecret } from "../../platform/auth/oauth.js";

describe.skipIf(process.env.DATABASE_URL === undefined)(
  "Postgres non-human credential lifecycle",
  () => {
    const sql = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
    const store = new PostgresAgentCredentialStore(sql);
    const orgId = "f1630000-0000-4000-8000-000000000001";
    const otherOrgId = "f1630000-0000-4000-8000-000000000002";
    const ownerId = "f1630000-0000-4000-8000-000000000011";
    const peerOwnerId = "f1630000-0000-4000-8000-000000000012";
    const agentId = "f1630000-0000-4000-8000-000000000021";
    const serviceId = "f1630000-0000-4000-8000-000000000022";
    const foreignServiceId = "f1630000-0000-4000-8000-000000000023";
    const expiresAt = new Date(Date.now() + 30 * 86_400_000);

    beforeAll(async () => {
      await cleanup();
      await sql`insert into orgs (id, slug, display_name) values
        (${orgId}, 'iam20-test', 'IAM 20'),
        (${otherOrgId}, 'iam20-other', 'IAM 20 Other')`;
      await sql`insert into actors (id, org_id, type, email, display_name, scopes) values
        (${ownerId}, ${orgId}, 'user', 'owner@iam20.example', 'Owner', array['admin.agents']),
        (${peerOwnerId}, ${orgId}, 'user', 'peer@iam20.example', 'Peer', array['admin.agents']),
        (${agentId}, ${orgId}, 'agent', null, 'Mail agent', array['mail.read']),
        (${serviceId}, ${orgId}, 'service_account', null, 'Importer', array['drive.write']),
        (${foreignServiceId}, ${otherOrgId}, 'service_account', null, 'Foreign', array['drive.write'])`;
    });

    afterAll(async () => {
      await cleanup();
      await sql.end();
    });

    it("issues, inventories, rotates, uses, and revokes every credential type", async () => {
      const oauth = await store.issue({
        orgId,
        operatorActorId: ownerId,
        principalActorId: agentId,
        credentialType: "oauth_client",
        label: "Mail OAuth",
        purpose: "Process inbound mail",
        scopes: ["mail.read"],
        expiresAt,
        clientId: "iam20-oauth",
        secretHash: await hashSecret("old-oauth-secret"),
      });
      const api = await store.issue({
        orgId,
        operatorActorId: ownerId,
        principalActorId: serviceId,
        credentialType: "api_key",
        label: "Import key",
        purpose: "Import customer files",
        scopes: ["drive.write"],
        expiresAt,
        apiKeyHash: hashApiKey("helix_ak_old"),
      });
      const certificate = await store.issue({
        orgId,
        operatorActorId: ownerId,
        principalActorId: serviceId,
        credentialType: "mtls_cert",
        label: "Warehouse mTLS",
        purpose: "Authenticate warehouse uploads",
        scopes: ["drive.write"],
        expiresAt,
        certFingerprint: "a".repeat(64),
      });

      expect(await store.list({ orgId, includeRevoked: false })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: oauth.id, principalType: "agent", ownerActorId: ownerId }),
          expect.objectContaining({
            id: api.id,
            principalType: "service_account",
            purpose: "Import customer files",
          }),
          expect.objectContaining({ id: certificate.id, credentialType: "mtls_cert" }),
        ]),
      );

      await expect(
        authenticateApiKey(store, "helix_ak_old", { at: new Date() }),
      ).resolves.toMatchObject({ ok: true, credential: { id: api.id } });
      expect(
        (await store.list({ orgId, includeRevoked: false })).find((row) => row.id === api.id)
          ?.lastUsedAt,
      ).toBeInstanceOf(Date);

      await store.rotate({
        orgId,
        operatorActorId: ownerId,
        credentialId: oauth.id,
        expiresAt,
        secretHash: await hashSecret("new-oauth-secret"),
      });
      await store.rotate({
        orgId,
        operatorActorId: ownerId,
        credentialId: api.id,
        expiresAt,
        apiKeyHash: hashApiKey("helix_ak_new"),
      });
      await store.rotate({
        orgId,
        operatorActorId: ownerId,
        credentialId: certificate.id,
        expiresAt,
        certFingerprint: "b".repeat(64),
      });
      await expect(authenticateApiKey(store, "helix_ak_old", {})).resolves.toMatchObject({
        ok: false,
      });
      await expect(authenticateApiKey(store, "helix_ak_new", {})).resolves.toMatchObject({
        ok: true,
      });

      for (const credential of [oauth, api, certificate]) {
        await expect(
          store.revoke({ orgId, operatorActorId: ownerId, credentialId: credential.id }),
        ).resolves.toMatchObject({ id: credential.id, revokedAt: expect.any(Date) });
      }
      expect(await store.list({ orgId, includeRevoked: false })).toEqual([]);
      expect(await store.list({ orgId, includeRevoked: true })).toHaveLength(3);

      const activity = await sql<{ readonly verb: string; readonly payload: unknown }[]>`
        select verb, payload from activity where org_id = ${orgId}
          and object_type = 'agent_credential' order by sequence
      `;
      expect(activity.map((row) => row.verb)).toEqual([
        ...Array<string>(3).fill("nonhuman.credential.issued"),
        ...Array<string>(3).fill("nonhuman.credential.rotated"),
        ...Array<string>(3).fill("nonhuman.credential.revoked"),
      ]);
      expect(JSON.stringify(activity)).not.toContain("old-oauth-secret");
      const outbox = await sql<{ readonly count: number }[]>`
        select count(*)::int as count from outbox
        where subject = 'security.nonhuman-credential.changed'
          and payload->>'orgId' = ${orgId}
      `;
      expect(outbox[0]?.count).toBe(9);
    });

    it("rejects human, cross-tenant, and non-owner rotation", async () => {
      const evidenceBefore = await evidenceCount();
      await expect(
        store.issue({
          orgId,
          operatorActorId: ownerId,
          principalActorId: ownerId,
          credentialType: "api_key",
          label: "Invalid",
          purpose: "Must not bind a user",
          scopes: ["mail.read"],
          expiresAt,
          apiKeyHash: hashApiKey("helix_ak_human"),
        }),
      ).rejects.toThrow(/agent or service account/u);
      await expect(
        store.issue({
          orgId,
          operatorActorId: ownerId,
          principalActorId: foreignServiceId,
          credentialType: "api_key",
          label: "Invalid",
          purpose: "Must not cross tenants",
          scopes: ["drive.write"],
          expiresAt,
          apiKeyHash: hashApiKey("helix_ak_foreign"),
        }),
      ).rejects.toThrow(/agent or service account|actor_org_fk/u);
      expect(await evidenceCount()).toBe(evidenceBefore);

      const owned = await store.issue({
        orgId,
        operatorActorId: ownerId,
        principalActorId: serviceId,
        credentialType: "api_key",
        label: "Owned key",
        purpose: "Prove accountable ownership",
        scopes: ["drive.write"],
        expiresAt,
        apiKeyHash: hashApiKey("helix_ak_owned"),
      });
      await expect(
        store.rotate({
          orgId,
          operatorActorId: peerOwnerId,
          credentialId: owned.id,
          expiresAt,
          apiKeyHash: hashApiKey("helix_ak_peer"),
        }),
      ).rejects.toThrow(/accountable owner/u);
      await expect(
        store.revoke({ orgId, operatorActorId: peerOwnerId, credentialId: owned.id }),
      ).resolves.toMatchObject({ id: owned.id, revokedAt: expect.any(Date) });
    });

    async function evidenceCount(): Promise<number> {
      const rows = await sql<{ readonly count: number }[]>`
        select count(*)::int as count from activity
        where org_id = ${orgId} and object_type = 'agent_credential'
      `;
      return rows[0]?.count ?? 0;
    }

    async function cleanup(): Promise<void> {
      await sql`delete from outbox where payload->>'orgId' in (${orgId}, ${otherOrgId})`;
      await sql`delete from activity where org_id in (${orgId}, ${otherOrgId})`;
      await sql`delete from audit_chain_heads where org_id in (${orgId}, ${otherOrgId})`;
      await sql`delete from agent_credentials where org_id in (${orgId}, ${otherOrgId})`;
      await sql`delete from actors where org_id in (${orgId}, ${otherOrgId})`;
      await sql`delete from orgs where id in (${orgId}, ${otherOrgId})`;
    }
  },
);
