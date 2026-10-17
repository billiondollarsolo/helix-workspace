import { randomBytes } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import { z } from "zod";
import { ConflictError, NotFoundError } from "../../api/api-error.js";
import { withTenantIoSagaPostgresContext } from "../tenancy/postgres-roles.js";
import { createApiKeyMaterial } from "./credentials.js";
import type { FamilyPairing, FamilyApplicationRow } from "./family-pairing.js";

export const familyRotationInput = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["oidc", "scim", "enrollment"]),
  })
  .strict();
export interface FamilyCredentialRotation {
  readonly id: string;
  readonly kind: "oidc" | "scim" | "enrollment";
  readonly revision: number;
  readonly secret: string;
  readonly clientId?: string;
  readonly expiresAt?: string;
  readonly enrollmentCredentialId?: string;
}

/** Persist the replacement before sending it; a lost response reuses the same secret. */
export async function prepareFamilyRotation(
  family: FamilyPairing,
  actor: Actor,
  appId: string,
  input: z.infer<typeof familyRotationInput>,
  headers: Headers,
) {
  family.admin(actor);
  return withTenantIoSagaPostgresContext(
    family.sql,
    { orgId: actor.orgId, actorId: actor.id },
    async (tx) => {
      const [row] = await tx<
        FamilyApplicationRow[]
      >`select * from family_applications where org_id=${actor.orgId} and id=${appId} and status='active' for update`;
      if (!row) throw new NotFoundError("An active application connection is required.");
      const material = family.material(row);
      if (material.lastRotationId === input.id) return row;
      if (material.pendingRotation) {
        if (
          material.pendingRotation.id !== input.id ||
          material.pendingRotation.kind !== input.kind
        )
          throw new ConflictError(
            "Another credential rotation is awaiting the receiving app. Wait for it to finish.",
          );
        return row;
      }
      const revision = (material.credentialRevision ?? 0) + 1;
      if (!Number.isSafeInteger(revision))
        throw new ConflictError("Credential revision exhausted.");
      let rotation: FamilyCredentialRotation;
      if (input.kind === "oidc") {
        const client = await family.clients.create(
          { orgId: actor.orgId, appId, origin: row.public_origin },
          headers,
        );
        await tx`update "oauthClient" set disabled=true where metadata->>'helix_org_id'=${actor.orgId} and metadata->>'helix_app_id'=${appId} and "clientId" not in (${client.clientId},${material.receipt.clientId})`;
        rotation = { ...input, revision, secret: client.clientSecret, clientId: client.clientId };
      } else if (input.kind === "scim") {
        rotation = { ...input, revision, secret: randomBytes(32).toString("hex") };
      } else {
        const key = createApiKeyMaterial(),
          expiresAt = new Date(Date.now() + 90 * 24 * 3600_000);
        const credential = await family.credentials.issue({
          orgId: actor.orgId,
          operatorActorId: actor.id,
          principalActorId: material.enrollmentActorId,
          credentialType: "api_key",
          label: "Bot installation enrollment",
          purpose: "Request individually approved Bot accounts. No Mail, Chat or Drive grants.",
          scopes: ["platform.read", "agent.accounts.request"],
          expiresAt,
          apiKeyHash: key.apiKeyHash,
        });
        rotation = {
          ...input,
          revision,
          secret: key.apiKey,
          expiresAt: expiresAt.toISOString(),
          enrollmentCredentialId: credential.id,
        };
      }
      const [saved] = await tx<
        FamilyApplicationRow[]
      >`update family_applications set receipt_envelope=${family.cipher.seal(actor.orgId, "family-application", JSON.stringify({ ...material, pendingRotation: rotation }))},next_sync_at=now(),directory_pending=true where org_id=${actor.orgId} and id=${appId} returning *`;
      if (!saved) throw new Error("Credential rotation could not be retained");
      await family.record(tx, actor.orgId, actor.id, appId, "family.credential.rotation_prepared");
      return saved;
    },
  );
}

export async function deliverFamilyRotation(family: FamilyPairing, row: FamilyApplicationRow) {
  const material = family.material(row),
    rotation = material.pendingRotation;
  if (!rotation) return;
  const { enrollmentCredentialId: _credentialId, ...wire } = rotation;
  await family.request(
    row.public_origin,
    `/v1/family/${row.connection_id}/credentials`,
    material.scimToken,
    wire,
  );
  await withTenantIoSagaPostgresContext(
    family.sql,
    { orgId: row.org_id, serviceContext: true },
    async (tx) => {
      const [current] = await tx<
        FamilyApplicationRow[]
      >`select * from family_applications where org_id=${row.org_id} and id=${row.id} for update`;
      if (!current || current.status !== "active") return;
      const latest = family.material(current);
      if (latest.pendingRotation?.id !== rotation.id) return;
      const { pendingRotation: _pending, ...retained } = latest;
      const receipt = { ...latest.receipt };
      if (rotation.kind === "oidc") {
        if (!rotation.clientId) throw new Error("Pending client is missing");
        receipt.clientId = rotation.clientId;
        receipt.clientSecret = rotation.secret;
        await tx`update family_applications set oidc_client_id=${rotation.clientId} where org_id=${row.org_id} and id=${row.id}`;
        await family.clients.disable(latest.receipt.clientId);
      } else if (rotation.kind === "enrollment") {
        if (!rotation.enrollmentCredentialId || !rotation.expiresAt)
          throw new Error("Pending enrollment credential is missing");
        receipt.enrollmentKey = rotation.secret;
        receipt.enrollmentExpiresAt = rotation.expiresAt;
        await tx`update agent_credentials set revoked_at=coalesce(revoked_at,now()),updated_at=now() where org_id=${row.org_id} and id=${latest.enrollmentCredentialId}`;
      }
      const saved = {
        ...retained,
        receipt,
        credentialRevision: rotation.revision,
        lastRotationId: rotation.id,
        ...(rotation.kind === "scim" ? { scimToken: rotation.secret } : {}),
        ...(rotation.enrollmentCredentialId
          ? { enrollmentCredentialId: rotation.enrollmentCredentialId }
          : {}),
      };
      await tx`update family_applications set receipt_envelope=${family.cipher.seal(row.org_id, "family-application", JSON.stringify(saved))},next_sync_at=now(),last_error=null where org_id=${row.org_id} and id=${row.id}`;
      await family.record(tx, row.org_id, null, row.id, "family.credential.rotated");
    },
  );
}
