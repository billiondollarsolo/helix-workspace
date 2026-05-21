import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { Actor } from "@helix/sdk-types";

export interface AIArtifactRecord {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string | null;
  readonly providerId: string;
  readonly model: string;
  readonly feature: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface AIArtifactCreateInput {
  readonly actor: Actor;
  readonly providerId: string;
  readonly model: string;
  readonly feature: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly metadata?: Record<string, unknown>;
}

interface AIArtifactRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string | null;
  readonly provider_id: string;
  readonly model: string;
  readonly feature: string;
  readonly input_hash: string;
  readonly output_hash: string;
  readonly metadata: Record<string, unknown>;
  readonly created_at: Date;
}

export class PostgresAIProvenanceStore {
  constructor(private readonly sql: postgres.Sql) {}

  async record(input: AIArtifactCreateInput): Promise<{ readonly id: string }> {
    const actorId = isUuid(input.actor.id) ? input.actor.id : null;
    const rows = (await this.sql`
      insert into ai_artifacts (
        org_id, actor_id, provider_id, model, feature, input_hash, output_hash, metadata
      )
      values (
        ${input.actor.orgId},
        ${actorId},
        ${input.providerId},
        ${input.model},
        ${input.feature},
        ${input.inputHash},
        ${input.outputHash},
        ${this.sql.json(toSqlJson(input.metadata ?? {}))}
      )
      returning id
    `) as unknown as readonly { readonly id: string }[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Failed to record AI provenance.");
    }
    return { id: row.id };
  }

  async get(orgId: string, id: string): Promise<AIArtifactRecord | null> {
    const rows = (await this.sql`
      select * from ai_artifacts
      where org_id = ${orgId} and id = ${id}
      limit 1
    `) as unknown as readonly AIArtifactRow[];
    const row = rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          orgId: row.org_id,
          actorId: row.actor_id,
          providerId: row.provider_id,
          model: row.model,
          feature: row.feature,
          inputHash: row.input_hash,
          outputHash: row.output_hash,
          metadata: row.metadata,
          createdAt: row.created_at,
        };
  }
}

export function hashAIArtifactContent(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
