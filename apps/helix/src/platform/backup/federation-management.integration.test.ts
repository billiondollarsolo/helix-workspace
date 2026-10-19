import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { hashPassword } from "better-auth/crypto";
import { describe, expect, it, vi } from "vitest";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { createBetterAuthRuntime } from "../auth/better-auth.js";
import { bootstrapWorkspaceOwner } from "../auth/bootstrap-owner.js";
import { PostgresAdminUserInviteStore } from "../auth/admin-user-invites.js";
import { createCredentialUserForActor } from "../signup/verification.js";
import { PostgresAgentCredentialStore } from "../auth/postgres-store.js";
import { FederationPairing } from "../auth/federation-pairing.js";
import { TenantEnvelopeCipher } from "../secrets/envelope.js";
import { canonicalJson } from "../audit/hash.js";
import { createHash } from "node:crypto";
import { FederationBackupWorker, recoveryServer } from "./federation-worker.js";
import { workerConfiguration } from "./federation-worker-state.js";
import { FederationBackupManagement } from "./federation-management.js";
import type { Actor } from "@helix/sdk-types";

describe.skipIf(skipUnlessLiveDatabase("federation backup control plane"))(
  "federation backup control plane",
  () => {
    it("binds two apps, retries lost replies without replay, enforces approvals/tenants and exports verified recovery sets", async () => {
      const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? ""),
        sql = tenantAwarePostgresSql(postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? ""));
      const directory = mkdtempSync(join(tmpdir(), "federation-backup-control-"));
      const orgId = randomUUID(),
        otherOrg = randomUUID(),
        appId = randomUUID(),
        connectionId = randomUUID();
      const runtime = createBetterAuthRuntime({
        databaseUrl: process.env.HELIX_RLS_APP_DATABASE_URL ?? "",
        secret: "fixture-federation-backup-auth-secret-at-least-thirty-two",
        baseUrl: "http://localhost:3000",
        secureCookies: false,
        federationIdentity: {
          checkSession: async () => false,
          claims: async () => ({}),
          userInfo: async () => ({}),
        },
      });
      const servers: ReturnType<typeof recoveryServer>[] = [];
      const workers: FederationBackupWorker[] = [];
      async function worker(application: "workspace" | "bot") {
        const root = join(directory, application);
        const management = join(directory, `${application}.key`),
          restore = join(directory, `${application}.restore`);
        writeFileSync(management, "a".repeat(64), { mode: 0o600 });
        writeFileSync(restore, "b".repeat(64), { mode: 0o600 });
        const script = `const fs=require('node:fs');const {request,source,policy}=JSON.parse(fs.readFileSync(process.env.HELIX_FEDERATION_BACKUP_REQUEST_FILE,'utf8'));const now=new Date().toISOString();const receipt=source||{backupId:request.id,createdAt:now,artifactDigest:'a'.repeat(64),manifestDigest:'b'.repeat(64),encrypted:true,destinationRef:policy.destinationRef,retentionDays:policy.retentionDays,offHost:true,keyCustodyRef:'vault:fixture',coverage:['database','files','objects','configuration'],appVersion:'fixture',schemaVersion:'249',databaseRecoveryPoint:now,objectRecoveryPoint:now,verifiedAt:null,restoredAt:null,targetDatabase:null,targetObjectBucket:null};if(request.kind!=='backup')receipt.verifiedAt=now;if(request.kind==='restore'){receipt.restoredAt=now;receipt.targetDatabase=request.targetDatabase;receipt.targetObjectBucket=request.targetObjectBucket??null;}fs.writeFileSync(process.env.HELIX_FEDERATION_BACKUP_RECEIPT_FILE,JSON.stringify(receipt),{mode:0o600});`;
        const instance = new FederationBackupWorker(
          workerConfiguration.parse({
            binding: {
              application,
              installationId: randomUUID(),
              orgId,
              tenantId: application === "workspace" ? orgId : randomUUID(),
              connectionId: application === "workspace" ? null : connectionId,
            },
            stateDirectory: root,
            managementKeyFile: management,
            restoreKeyFile: restore,
            scheduler: "worker",
            localSchedulerDisabled: true,
            destinations: ["offsite"],
            minimumRetentionDays: 30,
            requiredCoverage:
              application === "workspace"
                ? ["database", "objects", "configuration"]
                : ["database", "files", "configuration"],
            initialPolicy: {
              revision: 0,
              enabled: false,
              intervalMinutes: 5,
              retentionDays: 30,
              destinationRef: "offsite",
            },
            commands: {
              backup: [process.execPath, "-e", script],
              verify: [process.execPath, "-e", script],
              restore: [process.execPath, "-e", script],
            },
          }),
        );
        const server = recoveryServer(instance);
        servers.push(server);
        workers.push(instance);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing listener");
        return { instance, origin: `http://127.0.0.1:${String(address.port)}` };
      }
      try {
        await admin`insert into orgs(id,slug,display_name,status) values(${orgId},${orgId},'Recovery','active'),(${otherOrg},${otherOrg},'Other','active')`;
        const owner = await bootstrapWorkspaceOwner(sql, {
          orgId,
          email: `owner@${orgId}.test`,
          publicBaseUrl: "http://localhost:3000",
        });
        if (owner.status !== "invited") throw new Error("Owner missing");
        await withTenantPostgresContext(sql, { orgId }, (tx) =>
          createCredentialUserForActor(tx, {
            orgId,
            email: `owner@${orgId}.test`,
            passwordHash: "fixture-not-used-for-login",
          }),
        );
        const operator: Actor = {
          id: owner.actorId,
          orgId,
          type: "user",
          displayName: "Owner",
          scopes: ["admin.*"],
        };
        const invites = new PostgresAdminUserInviteStore(sql),
          invite = await invites.invite(operator, {
            email: `approver@${orgId}.test`,
            displayName: "Approver",
            role: "admin",
          });
        const accepted = await invites.accept(orgId, {
          token: invite.token,
          passwordHash: await hashPassword("private fixture password"),
        });
        if (accepted.status !== "accepted") throw new Error("Approver missing");
        const approver: Actor = { ...operator, id: accepted.actorId, displayName: "Approver" };
        const workspace = await worker("workspace"),
          bot = await worker("bot");
        await admin`insert into federation_applications(org_id,id,public_origin,installation_id,tenant_id,connection_id,created_by_actor_id,pairing_digest,proof_digest,pairing_expires_at,status)
        values(${orgId},${appId},${bot.origin},${bot.instance.config.binding.installationId},${bot.instance.config.binding.tenantId},${connectionId},${operator.id},${randomUUID()},${randomUUID()},now()+interval '10 minutes','active')`;
        if (!runtime.federationClients) throw new Error("Provider missing");
        const federation = new FederationPairing(
          sql,
          new TenantEnvelopeCipher("fixture-encryption-key-at-least-thirty-two-characters"),
          runtime.federationClients,
          new PostgresAgentCredentialStore(sql),
          workspace.origin,
          true,
        );
        const service = new FederationBackupManagement(federation, orgId, (error) => {
          throw error;
        });
        const selfId = randomUUID(),
          botId = randomUUID();
        await service.enroll(operator, {
          id: selfId,
          applicationId: null,
          managementKey: "a".repeat(64),
          restoreKey: "b".repeat(64),
        });
        await service.enroll(operator, {
          id: botId,
          applicationId: appId,
          managementKey: "a".repeat(64),
          restoreKey: "b".repeat(64),
        });
        expect(await service.list(operator)).toHaveLength(2);
        await expect(service.list({ ...operator, orgId: otherOrg })).rejects.toThrow();
        const leaked = await withTenantPostgresContext(
          sql,
          { orgId: otherOrg },
          (tx) => tx`select * from federation_backup_targets`,
        );
        expect(leaked).toHaveLength(0);
        await service.runOnce();
        let loseReply = true;
        const transport = federation.fetch;
        const mock = vi.spyOn(federation, "fetch").mockImplementation(async (url, options) => {
          const response = await transport(url, options);
          if (
            loseReply &&
            new URL(url instanceof Request ? url.url : url.toString()).pathname.endsWith("/jobs")
          ) {
            loseReply = false;
            throw new Error("Fixture lost acknowledgement");
          }
          return response;
        });
        const backupId = randomUUID();
        await service.createJob(operator, botId, { id: backupId, kind: "backup" }, 0);
        await service.runOnce();
        await bot.instance.runOnce();
        await service.runOnce();
        expect(bot.instance.state.jobs).toHaveLength(1);
        expect((await service.jobs(operator))[0]?.status).toBe("completed");
        mock.mockRestore();
        const selfBackup = randomUUID();
        await service.createJob(operator, selfId, { id: selfBackup, kind: "backup" }, 0);
        await service.runOnce();
        await workspace.instance.runOnce();
        await service.runOnce();
        for (const [target, artifact, instance] of [
          [selfId, selfBackup, workspace.instance],
          [botId, backupId, bot.instance],
        ] as const) {
          await service.createJob(
            operator,
            target,
            { id: randomUUID(), kind: "verify", backupId: artifact },
            0,
          );
          await service.runOnce();
          await instance.runOnce();
          await service.runOnce();
        }
        const recovery = await service.recoverySet(operator, randomUUID());
        expect(recovery.manifest.complete).toBe(true);
        expect(recovery.manifest.consistency).toBe("independent-snapshots");
        expect(createHash("sha256").update(canonicalJson(recovery.manifest)).digest("hex")).toBe(
          recovery.digest,
        );
        const restoreId = randomUUID();
        await service.createJob(
          operator,
          botId,
          { id: restoreId, kind: "restore", backupId, targetDatabase: "helix_restore_fixture" },
          1,
        );
        await expect(service.approve(operator, restoreId)).rejects.toThrow("different");
        await service.runOnce();
        expect(bot.instance.state.jobs).toHaveLength(2);
        await service.approve(approver, restoreId);
        await service.runOnce();
        await bot.instance.runOnce();
        await service.runOnce();
        expect((await service.jobs(operator)).find((job) => job.id === restoreId)?.status).toBe(
          "completed",
        );
        const revokedRestore = randomUUID();
        await service.createJob(
          operator,
          botId,
          {
            id: revokedRestore,
            kind: "restore",
            backupId,
            targetDatabase: "helix_restore_revoked",
          },
          1,
        );
        await service.approve(approver, revokedRestore);
        await admin`update actors set disabled_at=now() where org_id=${orgId} and id=${approver.id}`;
        await service.runOnce();
        expect(
          (await service.jobs(operator)).find((job) => job.id === revokedRestore)?.status,
        ).toBe("failed");
        expect(bot.instance.state.jobs.some((job) => job.request.id === revokedRestore)).toBe(
          false,
        );
        const audit =
          await admin`select payload from activity where org_id=${orgId} and verb='federation.backup.operation_updated' and object_id=${restoreId}`;
        expect(
          audit.some(
            (row) => (row.payload as { artifactDigest?: string }).artifactDigest === "a".repeat(64),
          ),
        ).toBe(true);
        const policy = { ...bot.instance.state.policy, revision: 1, enabled: true };
        await service.policy(operator, botId, policy);
        await service.runOnce();
        expect(bot.instance.state.policy).toEqual(policy);
        await admin`update federation_backup_targets set policy=jsonb_set(policy,'{revision}','0'::jsonb) where org_id=${orgId} and id=${botId}`;
        await service.runOnce();
        expect(
          (await service.list(operator)).find((target) => target.id === botId)?.error,
        ).toContain("newer policy");
        await service.detach(operator, botId);
        await service.runOnce();
        expect(bot.instance.state.owner).toBe("local");
        expect(bot.instance.state.policy.enabled).toBe(true);
      } finally {
        for (const server of servers)
          await new Promise<void>((resolve) =>
            server.close(() => {
              resolve();
            }),
          );
        for (const instance of workers) await instance.close();
        await runtime.pool.end();
        await cleanupTestTenants(admin, [orgId, otherOrg]);
        await Promise.all([admin.end(), sql.end()]);
        rmSync(directory, { recursive: true, force: true });
      }
    }, 30000);
  },
);
