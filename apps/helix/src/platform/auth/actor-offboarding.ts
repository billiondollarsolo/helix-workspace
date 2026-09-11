import type { Actor } from "@helix/sdk-types";
import type postgres from "postgres";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../api/api-error.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";

export interface ActorOffboardingInput {
  readonly actorId: string;
  readonly successorActorId?: string | undefined;
  readonly preserveReceivingAddresses?: boolean | undefined;
}
interface OffboardingActor {
  readonly id: string;
  readonly type: "user" | "agent" | "service_account";
  readonly displayName: string;
  readonly email: string | null;
}
interface OffboardingCounts {
  readonly driveFiles: number;
  readonly driveFolders: number;
  readonly mailMessages: number;
  readonly mailDrafts: number;
  readonly calendars: number;
  readonly contacts: number;
  readonly addressBooks: number;
  readonly assistantConversations: number;
  readonly assistantMemories: number;
}
export interface ActorOffboardingPreview {
  readonly source: OffboardingActor;
  readonly successor: OffboardingActor | null;
  readonly counts: OffboardingCounts;
  readonly receivingAddresses: readonly string[];
  readonly preserveReceivingAddresses: boolean;
  readonly blockers: readonly string[];
  readonly confirmationToken: string;
}
export interface ActorOffboardingResult {
  readonly actorId: string;
  readonly orgId: string;
  readonly disabled: boolean;
  readonly sessionsRevoked: number;
  readonly appPasswordsRevoked: number;
  readonly agentCredentialsRevoked: number;
  readonly successorActorId: string | null;
  readonly counts: OffboardingCounts;
  readonly preserveReceivingAddresses: boolean;
  readonly searchReindexJobId: string;
}

/** One database transaction owns handoff, access retirement, audit, and index repair. */
export class PostgresActorOffboardingStore {
  constructor(private readonly sql: postgres.Sql) {}

  preview(actor: Actor, input: ActorOffboardingInput): Promise<ActorOffboardingPreview> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) => {
        const [row] = await tx<{ preview: ActorOffboardingPreview | null }[]>`
        select helix_actor_offboard_preview(${actor.orgId}, ${input.actorId},
          ${input.successorActorId ?? null}, ${input.preserveReceivingAddresses ?? false}) preview
      `;
        if (row?.preview == null) throw new NotFoundError("Account not found in this workspace.");
        return row.preview;
      },
    ).catch(offboardingError);
  }

  offboard(
    actor: Actor,
    input: ActorOffboardingInput & { readonly confirmationToken: string },
  ): Promise<ActorOffboardingResult> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) => {
        const [row] = await tx<{ result: ActorOffboardingResult | null }[]>`
        select helix_offboard_actor(${actor.orgId}, ${input.actorId},
          ${input.successorActorId ?? null}, ${input.preserveReceivingAddresses ?? false}, ${input.confirmationToken}) result
      `;
        if (row?.result == null) throw new NotFoundError("Account not found in this workspace.");
        return row.result;
      },
    ).catch(offboardingError);
  }
}

function offboardingError(error: unknown): never {
  if (error instanceof Error && "code" in error) {
    if (error.code === "40001")
      throw new ConflictError("Account data or eligibility changed. Review the handoff again.");
    if (error.code === "42501") throw new ForbiddenError("Account offboarding permission denied.");
    if (error.code === "23505")
      throw new ConflictError(
        "A receiving address is assigned elsewhere. Review the handoff again.",
      );
    if (error.code === "23514") throw new BadRequestError(error.message);
  }
  throw error;
}
