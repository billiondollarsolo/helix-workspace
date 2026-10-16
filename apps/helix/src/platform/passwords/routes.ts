import { PASSWORD_VAULT_MAX_BYTES, passwordVaultWriteSchema } from "@helix/contracts";
import type { FastifyInstance } from "fastify";
import type { SessionActorResolver } from "../../api/actor.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} from "../../api/api-error.js";
import { auditAdminAction, type AdminConsoleAuditSink } from "../admin/console-shared.js";
import { assertActorMatchesRequestTenant } from "../tenancy/middleware.js";
import { setTenantPostgresActorId } from "../tenancy/postgres-roles.js";
import type { PostgresPasswordVaultStore } from "./vault.js";

export function registerPasswordVaultRoutes(
  app: FastifyInstance,
  options: {
    readonly store: Pick<PostgresPasswordVaultStore, "get" | "put">;
    readonly sessionActorResolver: SessionActorResolver | undefined;
    readonly enabled: (orgId: string) => Promise<boolean>;
    readonly audit: AdminConsoleAuditSink;
  },
) {
  app.route({
    method: ["GET", "PUT"],
    url: "/api/passwords/vault",
    schema: {
      tags: ["Passwords"],
      description:
        "Read or conditionally save the signed-in person's encrypted KDBX vault. Human browser sessions only; API keys, agents and OAuth clients are denied. Every request requires X-Helix-Vault-Owner matching the signed-in actor, preventing stale tabs from writing after an account switch. PUT requires expectedVersion and base64 ciphertext. GET includes the current and previous encrypted revision. No plaintext or vault master password is sent to Helix.",
      security: [{ sessionCookie: [] }],
    },
    async handler(request, reply) {
      const actor = await options.sessionActorResolver?.resolve(request);
      if (!actor || actor.id === "anonymous")
        throw new UnauthorizedError("Sign in to use Passwords.");
      assertActorMatchesRequestTenant(request, actor);
      if (actor.type !== "user")
        throw new ForbiddenError("Personal vaults require a human web session.");
      if (request.headers["x-helix-vault-owner"] !== actor.id)
        throw new ForbiddenError(
          "Your workspace identity changed. Sign in again to unlock your own vault.",
        );
      await setTenantPostgresActorId(actor.id);
      if (!(await options.enabled(actor.orgId)))
        throw new ForbiddenError("Your organization has turned Passwords off.");
      reply.header("cache-control", "no-store");
      if (request.method === "GET") {
        const result = await options.store.get(actor.orgId, actor.id);
        await auditAdminAction(options.audit, {
          orgId: actor.orgId,
          actorId: actor.id,
          verb: "passwords.vault.read",
          objectType: "actor",
          objectId: actor.id,
          metadata: {},
        });
        return result;
      }
      const parsed = passwordVaultWriteSchema.safeParse(request.body);
      if (!parsed.success)
        throw new BadRequestError("Provide an encrypted vault and its expected version.");
      const bytes = Buffer.from(parsed.data.ciphertext, "base64");
      if (
        bytes.length < 64 ||
        bytes.length > PASSWORD_VAULT_MAX_BYTES ||
        bytes.toString("base64") !== parsed.data.ciphertext ||
        bytes.readUInt32LE(0) !== 0x9aa2d903 ||
        bytes.readUInt32LE(4) !== 0xb54bfb67 ||
        bytes.readUInt16LE(10) !== 4
      ) {
        throw new BadRequestError(
          "Provide a KDBX 4 vault no larger than 1 MiB. Plaintext is not accepted.",
        );
      }
      const version = await options.store.put(
        actor.orgId,
        actor.id,
        parsed.data.expectedVersion,
        bytes,
      );
      if (version === null)
        throw new ConflictError(
          "This vault changed in another tab. Download your unsaved vault before reloading.",
        );
      await auditAdminAction(options.audit, {
        orgId: actor.orgId,
        actorId: actor.id,
        verb: "passwords.vault.saved",
        objectType: "actor",
        objectId: actor.id,
        metadata: { version, byteSize: bytes.length },
      });
      return { version };
    },
  });
}
