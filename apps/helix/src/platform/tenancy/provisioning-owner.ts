import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";

export const initialOwnerActorStepName = "initial_owner_actor_created";
export const initialOwnerActorScopes = ["admin.*"] as const;

export interface InitialOwnerActorInput {
  readonly orgId: string;
  readonly email: string;
  readonly displayName?: string | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface InitialOwnerActorRecord {
  readonly id: string;
  readonly orgId: string;
  readonly type: "user";
  readonly email: string;
  readonly displayName: string;
  readonly scopes: readonly string[];
  readonly metadata: JsonObject;
}

export interface TenantOwnerActorStore {
  ensureInitialOwnerActor(input: InitialOwnerActorInput): Promise<InitialOwnerActorRecord>;
}

interface InitialOwnerActorRow {
  readonly id: string;
  readonly org_id: string;
  readonly type: "user";
  readonly email: string;
  readonly display_name: string;
  readonly scopes: readonly string[];
  readonly metadata: JsonObject;
}

export class PostgresTenantOwnerActorStore implements TenantOwnerActorStore {
  constructor(private readonly sql: postgres.Sql) {}

  async ensureInitialOwnerActor(input: InitialOwnerActorInput): Promise<InitialOwnerActorRecord> {
    const email = normalizeOwnerEmail(input.email);
    const metadata = initialOwnerMetadata(input.metadata);
    const rows = (await this.sql`
      insert into actors (
        org_id,
        type,
        email,
        display_name,
        scopes,
        disabled_at,
        metadata
      )
      values (
        ${input.orgId},
        'user',
        ${email},
        ${input.displayName?.trim() || email},
        ${this.sql.array([...initialOwnerActorScopes], 1009)},
        null,
        ${this.sql.json(metadata)}
      )
      on conflict (org_id, email) do update
      set
        scopes = case
          when 'admin.*' = any(actors.scopes) then actors.scopes
          else array_append(actors.scopes, 'admin.*')
        end,
        disabled_at = null,
        metadata = actors.metadata || excluded.metadata,
        updated_at = now()
      returning id, org_id, type, email, display_name, scopes, metadata
    `) as unknown as readonly InitialOwnerActorRow[];
    return mapInitialOwnerActorRow(rows[0]);
  }
}

function initialOwnerMetadata(metadata: JsonObject | undefined): JsonObject {
  return {
    ...(metadata ?? {}),
    tenantProvisioning: {
      role: "owner",
      source: "signup",
    },
  };
}

function normalizeOwnerEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("initial owner email is required");
  }
  return normalized;
}

function mapInitialOwnerActorRow(
  row: InitialOwnerActorRow | undefined,
): InitialOwnerActorRecord {
  if (row === undefined) {
    throw new Error("initial owner actor query returned no rows");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    type: row.type,
    email: row.email,
    displayName: row.display_name,
    scopes: row.scopes,
    metadata: row.metadata,
  };
}
