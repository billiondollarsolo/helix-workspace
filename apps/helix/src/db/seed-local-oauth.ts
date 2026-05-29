import { pathToFileURL } from "node:url";
import type postgres from "postgres";
import { createSqlClient } from "./client.js";
import { hashSecret } from "../platform/auth/oauth.js";

export const DEFAULT_LOCAL_OAUTH_ORG_ID = "00000000-0000-4000-8000-000000000100";
export const DEFAULT_LOCAL_OAUTH_ACTOR_ID = "00000000-0000-4000-8000-000000000101";
export const DEFAULT_LOCAL_OAUTH_EMAIL = "local-admin@helix.local";
export const DEFAULT_LOCAL_OAUTH_DISPLAY_NAME = "Local Helix Admin";
export const DEFAULT_LOCAL_OAUTH_CLIENT_ID = "helix-local-oauth-client";
export const DEFAULT_LOCAL_OAUTH_CLIENT_SECRET = "helix-local-dev-secret";

export const DEFAULT_LOCAL_OAUTH_SCOPES = [
  "platform.read",
  "mail.read",
  "mail.send",
  "mail.write",
  "chat.read",
  "chat.write",
  "docs.read",
  "docs.write",
  "docs.comment",
  "drive.read",
  "drive.write",
  "drive.delete",
  "calendar.read",
  "calendar.read:freebusy",
  "calendar.write",
  "calendar.write:respond",
  "assistant.write",
  "assistant.memory",
  "meet.read",
  "meet.write",
  "admin.users",
  "admin.audit",
  "admin.agents",
  "admin.plugins",
  "admin.webhooks",
  "admin.config.read",
  "admin.config.write",
  "admin.config.*",
] as const;

export interface SeedLocalOAuthOptions {
  readonly orgId?: string;
  readonly actorId?: string;
  readonly actorType?: "user" | "agent" | "service_account";
  readonly email?: string;
  readonly displayName?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scopes?: readonly string[];
  readonly apiBaseUrl?: string;
}

export interface SeedLocalOAuthResult {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly actorId: string;
  readonly orgId: string;
  readonly scopes: readonly string[];
  readonly sampleTokenCommand: string;
  readonly warning: string;
}

type SeedSql = postgres.Sql;

export async function seedLocalOAuth(
  sql: SeedSql,
  options: SeedLocalOAuthOptions = {},
): Promise<SeedLocalOAuthResult> {
  const orgId = options.orgId ?? DEFAULT_LOCAL_OAUTH_ORG_ID;
  const actorId = options.actorId ?? DEFAULT_LOCAL_OAUTH_ACTOR_ID;
  const actorType = options.actorType ?? "user";
  const email = options.email ?? DEFAULT_LOCAL_OAUTH_EMAIL;
  const displayName = options.displayName ?? DEFAULT_LOCAL_OAUTH_DISPLAY_NAME;
  const clientId = options.clientId ?? DEFAULT_LOCAL_OAUTH_CLIENT_ID;
  const clientSecret =
    options.clientSecret ??
    process.env.HELIX_SEED_CLIENT_SECRET ??
    DEFAULT_LOCAL_OAUTH_CLIENT_SECRET;
  const scopes = uniqueScopes(options.scopes ?? DEFAULT_LOCAL_OAUTH_SCOPES);
  const apiBaseUrl =
    options.apiBaseUrl ?? process.env.HELIX_API_BASE_URL ?? "http://127.0.0.1:3000";
  const secretHash = await hashSecret(clientSecret);

  await sql`
    insert into actors (
      id,
      org_id,
      type,
      email,
      display_name,
      scopes,
      disabled_at,
      metadata
    )
    values (
      ${actorId},
      ${orgId},
      ${actorType},
      ${email},
      ${displayName},
      ${sql.array(scopes, 1009)},
      null,
      ${JSON.stringify({ source: "local-seed" })}::jsonb
    )
    on conflict (id) do update
    set
      org_id = excluded.org_id,
      type = excluded.type,
      email = excluded.email,
      display_name = excluded.display_name,
      scopes = excluded.scopes,
      disabled_at = null,
      metadata = actors.metadata || excluded.metadata,
      updated_at = now()
  `;

  await sql`
    insert into agent_credentials (
      actor_id,
      credential_type,
      client_id,
      secret_hash,
      scopes,
      expires_at,
      revoked_at,
      created_by,
      metadata
    )
    values (
      ${actorId},
      ${"oauth_client"},
      ${clientId},
      ${secretHash},
      ${sql.array(scopes, 1009)},
      null,
      null,
      ${actorId},
      ${JSON.stringify({ source: "local-seed" })}::jsonb
    )
    on conflict (client_id) where revoked_at is null do update
    set
      actor_id = excluded.actor_id,
      credential_type = excluded.credential_type,
      secret_hash = excluded.secret_hash,
      scopes = excluded.scopes,
      expires_at = null,
      revoked_at = null,
      created_by = excluded.created_by,
      metadata = agent_credentials.metadata || excluded.metadata
  `;

  return {
    clientId,
    clientSecret,
    actorId,
    orgId,
    scopes,
    sampleTokenCommand: buildSampleTokenCommand({ apiBaseUrl, clientId, clientSecret, scopes }),
    warning:
      "Local development seed only. Do not use this client secret outside local evidence runs.",
  };
}

function uniqueScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)];
}

function buildSampleTokenCommand(input: {
  readonly apiBaseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
}): string {
  const url = `${input.apiBaseUrl.replace(/\/+$/, "")}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: input.scopes.join(" "),
  }).toString();
  return `curl -sS -X POST ${shellQuote(url)} -u ${shellQuote(`${input.clientId}:${input.clientSecret}`)} -H ${shellQuote("content-type: application/x-www-form-urlencoded")} --data ${shellQuote(body)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function main(): Promise<void> {
  const sql = createSqlClient();
  try {
    const result = await seedLocalOAuth(sql);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
