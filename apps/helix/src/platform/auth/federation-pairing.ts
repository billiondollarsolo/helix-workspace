import type { FederationCredentialRotation } from "./federation-credentials.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import type postgres from "postgres";
import { z } from "zod";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../api/api-error.js";
import { canWriteAdminConsole } from "../admin/console-shared.js";
import { createOutboundHttpClient } from "../outbound-http.js";
import type { TenantEnvelopeCipher } from "../secrets/envelope.js";
import {
  withTenantIoSagaPostgresContext,
  withTenantPostgresContext,
} from "../tenancy/postgres-roles.js";
import type { BetterAuthRuntime } from "./better-auth.js";
import { createApiKeyMaterial } from "./credentials.js";
import type { PostgresAgentCredentialStore } from "./postgres-store.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class FederationPeerEndedError extends Error {}
export const federationRegistrationInput = z
  .object({
    id: z.string().uuid(),
    origin: z.string().url().max(2048),
    connectionId: z.string().uuid(),
    proof: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const federationRedemptionInput = z
  .object({
    orgId: z.string().uuid(),
    appId: z.string().uuid(),
    connectionId: z.string().uuid(),
    proof: z.string().regex(/^[a-f0-9]{64}$/u),
    token: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
type Redemption = z.infer<typeof federationRedemptionInput>;
interface Receipt {
  appId: string;
  orgId: string;
  connectionId: string;
  installationId: string;
  tenantId: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  enrollmentKey: string;
  enrollmentExpiresAt: string;
}
export interface FederationMaterial {
  receipt: Receipt;
  scimToken: string;
  pairingCode: string;
  enrollmentCredentialId: string;
  enrollmentActorId: string;
  credentialRevision?: number;
  lastRotationId?: string;
  pendingRotation?: FederationCredentialRotation;
}
export interface FederationApplicationRow {
  org_id: string;
  id: string;
  public_origin: string;
  installation_id: string;
  tenant_id: string;
  connection_id: string;
  status: string;
  created_by_actor_id: string;
  pairing_digest: string;
  proof_digest: string;
  pairing_expires_at: Date;
  oidc_client_id: string | null;
  receipt_envelope: string | null;
  revision: string;
  directory_revision: string;
  last_synced_at: Date | null;
  last_error: string | null;
  directory_pending: boolean;
  retry_count: number;
}
export class FederationPairing {
  readonly fetch: typeof fetch;
  constructor(
    readonly sql: postgres.Sql,
    readonly cipher: TenantEnvelopeCipher,
    readonly clients: NonNullable<BetterAuthRuntime["federationClients"]>,
    readonly credentials: PostgresAgentCredentialStore,
    readonly publicOrigin: string,
    allowPrivateNetwork = false,
  ) {
    this.fetch = createOutboundHttpClient({
      allowHttp: allowPrivateNetwork,
      allowPrivateNetwork,
      maxRedirects: 0,
      maxRequestBytes: 2_000_000,
      maxResponseBytes: 2_000_000,
      timeoutMs: 15_000,
    });
  }
  admin(actor: Actor) {
    if (actor.type !== "user" || !canWriteAdminConsole(actor, "admin.agents"))
      throw new ForbiddenError("A Workspace administrator must review application connections.");
  }
  material(row: FederationApplicationRow): FederationMaterial {
    if (row.receipt_envelope === null)
      throw new ConflictError("Application preparation was interrupted. Retry its registration.");
    return JSON.parse(
      this.cipher.open(row.org_id, "federation-application", row.receipt_envelope),
    ) as FederationMaterial;
  }
  async request(origin: string, path: string, token: string, body: unknown) {
    const response = await this.fetch(new URL(path, origin), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "HelixWorkspace/1.0",
      },
      body: JSON.stringify(body),
    });
    if (response.status === 410)
      throw new FederationPeerEndedError("The receiving application ended this connection.");
    if (!response.ok)
      throw new ConflictError(
        `Bot refused the application operation (HTTP ${String(response.status)}). Check its connection status and retry.`,
      );
    return response.json() as Promise<unknown>;
  }
  view(row: FederationApplicationRow) {
    return {
      id: row.id,
      origin: row.public_origin,
      status: row.status,
      installationId: row.installation_id,
      tenantId: row.tenant_id,
      lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
      error: row.last_error,
      pending: row.directory_pending,
      rotationPending:
        row.receipt_envelope !== null && this.material(row).pendingRotation !== undefined,
    };
  }
  async list(actor: Actor) {
    this.admin(actor);
    return withTenantPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) =>
        (
          await tx<
            FederationApplicationRow[]
          >`select * from federation_applications where org_id=${actor.orgId} order by created_at desc limit 100`
        ).map((row) => this.view(row)),
    );
  }
  async register(
    actor: Actor,
    input: z.infer<typeof federationRegistrationInput>,
    headers: Headers,
  ) {
    this.admin(actor);
    const origin = new URL(input.origin);
    if (
      origin.origin !== input.origin ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      (origin.protocol !== "https:" &&
        !(
          origin.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
        ))
    )
      throw new BadRequestError("Enter Bot's canonical HTTPS origin, without a path.");
    const existing = await withTenantIoSagaPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) => {
        const [row] = await tx<
          FederationApplicationRow[]
        >`select * from federation_applications where org_id=${actor.orgId} and id=${input.id}`;
        return row;
      },
    );
    if (existing && existing.receipt_envelope !== null) {
      if (
        existing.public_origin !== input.origin ||
        existing.connection_id !== input.connectionId ||
        !equal(existing.proof_digest, digest(input.proof))
      )
        throw new ConflictError("This operation belongs to a different receiving installation.");
      if (existing.status !== "prepared" || existing.pairing_expires_at.getTime() <= Date.now())
        throw new ConflictError("This application is already paired or its pairing has expired.");
      return {
        ...this.view(existing),
        pairingCode: this.material(existing).pairingCode,
        expiresAt: existing.pairing_expires_at.toISOString(),
      };
    }
    const nonce = randomBytes(32).toString("hex");
    const proof = z
      .object({
        connectionId: z.string().uuid(),
        installationId: z.string().uuid(),
        tenantId: z.string().uuid(),
        nonce: z.literal(nonce),
        expiresAt: z.number().int().positive(),
        scimToken: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .parse(
        await this.request(
          input.origin,
          `/v1/federation/${input.connectionId}/proof`,
          input.proof,
          {
            nonce,
          },
        ),
      );
    if (proof.expiresAt <= Date.now())
      throw new ConflictError("The installation proof has expired.");
    if (proof.connectionId !== input.connectionId)
      throw new ConflictError("Bot returned a different installation proof.");
    return withTenantIoSagaPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`federation:${actor.orgId}:${input.id}`},0))`;
        const [current] = await tx<
          FederationApplicationRow[]
        >`select * from federation_applications where org_id=${actor.orgId} and id=${input.id} for update`;
        if (current?.receipt_envelope) {
          if (
            current.public_origin !== input.origin ||
            current.connection_id !== input.connectionId ||
            !equal(current.proof_digest, digest(input.proof))
          )
            throw new ConflictError(
              "This operation belongs to a different receiving installation.",
            );
          if (current.status !== "prepared" || current.pairing_expires_at.getTime() <= Date.now())
            throw new ConflictError(
              "This application is already paired or its pairing has expired.",
            );
          return {
            ...this.view(current),
            pairingCode: this.material(current).pairingCode,
            expiresAt: current.pairing_expires_at.toISOString(),
          };
        }
        if (current)
          throw new ConflictError(
            "This registration is incomplete. Remove it before preparing another connection.",
          );
        const token = randomBytes(32).toString("hex"),
          expiresAt = new Date(Math.min(Date.now() + 600_000, proof.expiresAt));
        await tx`insert into federation_applications(org_id,id,public_origin,installation_id,tenant_id,connection_id,created_by_actor_id,pairing_digest,proof_digest,pairing_expires_at)
        values(${actor.orgId},${input.id},${input.origin},${proof.installationId},${proof.tenantId},${input.connectionId},${actor.id},${digest(token)},${digest(input.proof)},${expiresAt})`;
        const client = await this.clients.create(
          { orgId: actor.orgId, appId: input.id, origin: input.origin },
          headers,
        );
        // A crash before receipt commit can leave only an unbound, unusable client.
        await tx`update "oauthClient" set disabled=true where metadata->>'helix_org_id'=${actor.orgId}
        and metadata->>'helix_app_id'=${input.id} and "clientId"<>${client.clientId}`;
        const scopes = ["platform.read", "agent.accounts.request"];
        const [enrollment] = await tx<
          { id: string }[]
        >`insert into actors(org_id,type,display_name,parent_user_id,scopes,metadata)
        values(${actor.orgId},'agent','Bot installation enrollment',${actor.id},${tx.array(scopes)},${tx.json({ federationApplicationId: input.id, enrollmentOnly: true })}) returning id`;
        if (!enrollment) throw new Error("Enrollment identity was not created");
        const key = createApiKeyMaterial(),
          credentialExpiry = new Date(Date.now() + 90 * 24 * 3600_000);
        const credential = await this.credentials.issue({
          orgId: actor.orgId,
          operatorActorId: actor.id,
          principalActorId: enrollment.id,
          credentialType: "api_key",
          label: "Bot installation enrollment",
          purpose: "Request individually approved Bot accounts. No Mail, Chat or Drive grants.",
          scopes,
          expiresAt: credentialExpiry,
          apiKeyHash: key.apiKeyHash,
        });
        const pairingCode =
          "helix_federation_" +
          Buffer.from(
            JSON.stringify({
              version: 1,
              origin: this.publicOrigin,
              orgId: actor.orgId,
              appId: input.id,
              token,
            }),
          ).toString("base64url");
        const receipt: Receipt = {
          appId: input.id,
          orgId: actor.orgId,
          connectionId: input.connectionId,
          installationId: proof.installationId,
          tenantId: proof.tenantId,
          issuer: this.publicOrigin + "/v1/api/auth",
          ...client,
          enrollmentKey: key.apiKey,
          enrollmentExpiresAt: credentialExpiry.toISOString(),
        };
        const material: FederationMaterial = {
          receipt,
          scimToken: proof.scimToken,
          pairingCode,
          enrollmentCredentialId: credential.id,
          enrollmentActorId: enrollment.id,
        };
        const [saved] = await tx<
          FederationApplicationRow[]
        >`update federation_applications set oidc_client_id=${client.clientId},receipt_envelope=${this.cipher.seal(actor.orgId, "federation-application", JSON.stringify(material))} where org_id=${actor.orgId} and id=${input.id} returning *`;
        if (!saved) throw new Error("Application receipt was not stored");
        await this.record(tx, actor.orgId, actor.id, input.id, "federation.application.prepared");
        return { ...this.view(saved), pairingCode, expiresAt: expiresAt.toISOString() };
      },
    );
  }
  async redeem(input: Redemption, activate = false) {
    return withTenantIoSagaPostgresContext(
      this.sql,
      { orgId: input.orgId, serviceContext: true },
      async (tx) => {
        const [row] = await tx<
          FederationApplicationRow[]
        >`select * from federation_applications where org_id=${input.orgId} and id=${input.appId} for update`;
        if (
          !row ||
          !["prepared", "awaiting-peer", "active"].includes(row.status) ||
          row.pairing_expires_at.getTime() <= Date.now() ||
          row.connection_id !== input.connectionId ||
          !equal(row.pairing_digest, digest(input.token)) ||
          !equal(row.proof_digest, digest(input.proof))
        )
          throw new ForbiddenError(
            "Pairing authority is invalid, consumed by a different installation, or expired.",
          );
        const [owner] = await tx<
          { id: string; scopes: string[] }[]
        >`select a.id,a.scopes from actors a join organization_memberships m on m.org_id=a.org_id and m.actor_id=a.id
        where a.org_id=${row.org_id} and a.id=${row.created_by_actor_id} and a.type='user' and a.disabled_at is null and m.status='active'`;
        if (
          !owner ||
          !canWriteAdminConsole(
            { id: owner.id, orgId: row.org_id, type: "user", scopes: owner.scopes },
            "admin.agents",
          )
        )
          throw new ForbiddenError("The registering administrator no longer has authority.");
        const material = this.material(row);
        if (row.status !== "active") {
          await tx`update federation_applications set status=${activate ? "active" : "awaiting-peer"},updated_at=now(),directory_pending=true,next_sync_at=now()
          where org_id=${input.orgId} and id=${input.appId}`;
          await this.record(
            tx,
            row.org_id,
            row.created_by_actor_id,
            row.id,
            activate ? "federation.application.activated" : "federation.application.redeemed",
          );
        }
        return activate ? { activated: true } : material.receipt;
      },
    );
  }
  async assign(
    actor: Actor,
    appId: string,
    assignments: readonly { actorId: string; role: "viewer" | "member" | "admin" }[],
  ) {
    this.admin(actor);
    if (new Set(assignments.map((entry) => entry.actorId)).size !== assignments.length)
      throw new BadRequestError("A person appears twice.");
    await withTenantPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) => {
        const [row] =
          await tx`select id from federation_applications where org_id=${actor.orgId} and id=${appId} and status in ('prepared','awaiting-peer','active') for update`;
        if (!row) throw new NotFoundError("Application is unavailable.");
        for (const entry of assignments) {
          const [person] =
            await tx`select a.id from actors a join organization_memberships m on m.org_id=a.org_id and m.actor_id=a.id join identity_subjects s on s.id=m.subject_id and s.status='active' where a.org_id=${actor.orgId} and a.id=${entry.actorId} and a.type='user' and a.disabled_at is null and m.status='active'`;
          if (!person) throw new BadRequestError("Choose active people in this organization.");
        }
        await tx`delete from federation_app_assignments where org_id=${actor.orgId} and application_id=${appId}`;
        for (const entry of assignments)
          await tx`insert into federation_app_assignments(org_id,application_id,actor_id,role,identity_generation)
          select ${actor.orgId},${appId},${entry.actorId},${entry.role},s.federation_generation
          from organization_memberships m join identity_subjects s on s.id=m.subject_id and s.status='active'
          where m.org_id=${actor.orgId} and m.actor_id=${entry.actorId} and m.status='active' `;
        await this.record(
          tx,
          actor.orgId,
          actor.id,
          appId,
          "federation.application.assignments_changed",
        );
      },
    );
  }
  async assignments(actor: Actor, appId: string) {
    this.admin(actor);
    return withTenantPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) => {
        const rows = await tx<
          {
            actor_id: string;
            role: "viewer" | "member" | "admin";
            display_name: string;
            email: string | null;
          }[]
        >`select assigned.actor_id,assigned.role,a.display_name,a.email from federation_app_assignments assigned
        join actors a on a.org_id=assigned.org_id and a.id=assigned.actor_id and a.type='user' and a.disabled_at is null
        join organization_memberships m on m.org_id=assigned.org_id and m.actor_id=assigned.actor_id and m.status='active'
        join identity_subjects s on s.id=m.subject_id and s.status='active' and s.federation_generation=assigned.identity_generation
        where assigned.org_id=${actor.orgId} and assigned.application_id=${appId} order by assigned.actor_id`;
        return rows.map((row) => ({
          actorId: row.actor_id,
          role: row.role,
          displayName: row.display_name,
          email: row.email,
        }));
      },
    );
  }
  async revoke(actor: Actor, appId: string) {
    this.admin(actor);
    await withTenantPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) => {
        const [row] = await tx<
          FederationApplicationRow[]
        >`select * from federation_applications where org_id=${actor.orgId} and id=${appId} for update`;
        if (!row) throw new NotFoundError("Application is unavailable.");
        await tx`update federation_applications set status='revoked',directory_pending=true,next_sync_at=now() where org_id=${actor.orgId} and id=${appId}`;
        if (row.oidc_client_id) await this.clients.disable(row.oidc_client_id);
        if (row.receipt_envelope) {
          const material = this.material(row);
          await this.revokePendingCredentials(tx, row);
          await this.credentials.revoke({
            orgId: actor.orgId,
            operatorActorId: actor.id,
            credentialId: material.enrollmentCredentialId,
          });
          await tx`update actors set disabled_at=now() where org_id=${actor.orgId} and id=${material.enrollmentActorId}`;
        }
        await this.record(tx, actor.orgId, actor.id, appId, "federation.application.revoked");
      },
    );
  }
  async revokePendingCredentials(tx: postgres.TransactionSql, row: FederationApplicationRow) {
    if (!row.receipt_envelope) return;
    const pending = this.material(row).pendingRotation;
    if (pending?.clientId) await this.clients.disable(pending.clientId);
    if (pending?.enrollmentCredentialId)
      await tx`update agent_credentials set revoked_at=coalesce(revoked_at,now()),updated_at=now() where org_id=${row.org_id} and id=${pending.enrollmentCredentialId}`;
  }
  async retire(
    row: FederationApplicationRow,
    status: "revoked" | "failed",
    expectedRevision?: number,
  ) {
    await withTenantIoSagaPostgresContext(
      this.sql,
      { orgId: row.org_id, serviceContext: true },
      async (tx) => {
        const [current] = await tx<
          FederationApplicationRow[]
        >`select * from federation_applications where org_id=${row.org_id} and id=${row.id} for update`;
        if (
          !current ||
          (expectedRevision !== undefined && Number(current.revision) !== expectedRevision)
        )
          return;
        row = current;
        if (row.oidc_client_id) await this.clients.disable(row.oidc_client_id);
        if (row.receipt_envelope) {
          const material = this.material(row);
          await this.revokePendingCredentials(tx, row);
          await tx`update agent_credentials set revoked_at=coalesce(revoked_at,now()),updated_at=now() where org_id=${row.org_id} and id=${material.enrollmentCredentialId}`;
          await tx`update actors set disabled_at=coalesce(disabled_at,now()),updated_at=now() where org_id=${row.org_id} and id=${material.enrollmentActorId}`;
        }
        await tx`update federation_applications set status=${status},directory_pending=false,updated_at=now() where org_id=${row.org_id} and id=${row.id}`;
        await this.record(
          tx,
          row.org_id,
          null,
          row.id,
          status === "failed"
            ? "federation.application.recovery_required"
            : "federation.application.revoked_by_peer",
        );
      },
    );
  }
  async revokeByPeer(orgId: string, appId: string, connectionId: string, token: string) {
    const row = await withTenantIoSagaPostgresContext(
      this.sql,
      { orgId, serviceContext: true },
      async (tx) => {
        const [current] = await tx<
          FederationApplicationRow[]
        >`select * from federation_applications where org_id=${orgId} and id=${appId}`;
        return current;
      },
    );
    if (
      !row ||
      row.connection_id !== connectionId ||
      !row.receipt_envelope ||
      !equal(digest(this.material(row).scimToken), digest(token))
    )
      throw new ForbiddenError("The receiving installation's authority is invalid.");
    await this.retire(row, "revoked");
    return { revoked: true };
  }
  async record(
    tx: postgres.TransactionSql,
    orgId: string,
    actorId: string | null,
    appId: string,
    verb: string,
    payload: Record<string, string> = {},
    objectType = "federation_application",
  ) {
    await tx`insert into activity(org_id,actor_id,verb,object_type,object_id,payload,prev_hash,this_hash)
      values(${orgId},${actorId},${verb},${objectType},${appId},${tx.json(payload)},null,'')`;
  }
}
