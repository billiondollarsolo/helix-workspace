import type { Actor, ToolDefinition } from "@helix/sdk-types";
import type { ToolInvokeOptions } from "../tool-registry.js";
import { buildSafeActionPreview } from "./automation-policy.js";
import type postgres from "postgres";

export interface AgentSourceStore {
  get(orgId: string, actorId: string): Promise<readonly string[]>;
  /** Atomically retain the latest 128 distinct source identifiers for this actor. */
  record(orgId: string, actorId: string, sourceIds: readonly string[]): Promise<void>;
}

export class PostgresAgentSourceStore implements AgentSourceStore {
  constructor(private readonly sql: postgres.Sql) {}
  async get(orgId: string, actorId: string): Promise<readonly string[]> {
    const [row] = await this.sql<
      { source_ids: string[] }[]
    >`select source_ids from agent_source_context where org_id=${orgId} and actor_id=${actorId}`;
    return row?.source_ids ?? [];
  }
  async record(orgId: string, actorId: string, sourceIds: readonly string[]): Promise<void> {
    const sources = [...new Set(sourceIds)]
      .filter((id) => id.length > 0 && id.length <= 512)
      .slice(-128);
    await this.sql`insert into agent_source_context (org_id, actor_id, source_ids)
      values (${orgId}, ${actorId}, ${this.sql.array(sources)})
      on conflict (org_id,actor_id) do update set source_ids=(
        select coalesce(array_agg(source_id order by last_seen), '{}') from (
          select source_id, max(position) as last_seen from unnest(agent_source_context.source_ids || excluded.source_ids)
            with ordinality as sources(source_id, position) group by source_id order by max(position) desc limit 128
        ) recent
      ), updated_at=now()`;
  }
}

export async function recordAgentReadSources(
  store: AgentSourceStore | undefined,
  actor: Actor,
  tool: ToolDefinition,
  input: unknown,
  output: unknown,
  options: ToolInvokeOptions | undefined,
): Promise<ToolInvokeOptions | undefined> {
  const observed = [
    `tool:${tool.id}`,
    ...buildSafeActionPreview(tool, input).resourceIds,
    ...buildSafeActionPreview(tool, output).resourceIds,
  ].filter((id) => id.length > 0 && id.length <= 512);
  const sourceIds = [
    ...new Set([
      ...(options?.policyContext?.sourceIds ?? []).filter((id) => !observed.includes(id)),
      ...observed,
    ]),
  ].slice(-128);
  await store?.record(actor.orgId, actor.id, observed);
  return options?.policyContext === undefined
    ? options
    : { ...options, policyContext: { ...options.policyContext, sourceIds } };
}

export function isExternalAgentRequest(actor: Actor, channel: string): boolean {
  return (
    (actor.type === "agent" || actor.type === "service_account") &&
    ["mcp", "rest", "trpc", "pending_execution"].includes(channel)
  );
}
