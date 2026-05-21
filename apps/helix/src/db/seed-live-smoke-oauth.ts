import { pathToFileURL } from "node:url";
import { createSqlClient } from "./client.js";
import {
  DEFAULT_LOCAL_OAUTH_ORG_ID,
  seedLocalOAuth,
  type SeedLocalOAuthResult,
} from "./seed-local-oauth.js";

export const DEFAULT_LIVE_SMOKE_AGENT_ACTOR_ID = "00000000-0000-4000-8000-0000000001a1";
export const DEFAULT_LIVE_SMOKE_AGENT_CLIENT_ID = "helix-live-smoke-agent-client";
export const DEFAULT_LIVE_SMOKE_AGENT_CLIENT_SECRET = "helix-live-smoke-agent-secret";
export const DEFAULT_LIVE_SMOKE_AGENT_EMAIL = "helix-live-smoke-agent@helix.local";

export async function seedLiveSmokeAgentOAuth(): Promise<SeedLocalOAuthResult> {
  const sql = createSqlClient();
  try {
    return await seedLocalOAuth(sql, {
      orgId: process.env.HELIX_SMOKE_AGENT_ORG_ID ?? DEFAULT_LOCAL_OAUTH_ORG_ID,
      actorId: process.env.HELIX_SMOKE_AGENT_ACTOR_ID ?? DEFAULT_LIVE_SMOKE_AGENT_ACTOR_ID,
      actorType: smokeActorType(),
      email: process.env.HELIX_SMOKE_AGENT_EMAIL ?? DEFAULT_LIVE_SMOKE_AGENT_EMAIL,
      displayName: process.env.HELIX_SMOKE_AGENT_DISPLAY_NAME ?? "Live Smoke Agent",
      clientId: process.env.HELIX_SMOKE_AGENT_CLIENT_ID ?? DEFAULT_LIVE_SMOKE_AGENT_CLIENT_ID,
      clientSecret:
        process.env.HELIX_SMOKE_AGENT_CLIENT_SECRET ?? DEFAULT_LIVE_SMOKE_AGENT_CLIENT_SECRET,
      scopes: smokeAgentScopes(),
      ...(process.env.HELIX_API_BASE_URL === undefined
        ? {}
        : { apiBaseUrl: process.env.HELIX_API_BASE_URL }),
    });
  } finally {
    await sql.end();
  }
}

function smokeActorType(): "agent" | "service_account" {
  return process.env.HELIX_SMOKE_AGENT_ACTOR_TYPE === "service_account"
    ? "service_account"
    : "agent";
}

function smokeAgentScopes(): readonly string[] {
  const value = process.env.HELIX_SMOKE_AGENT_SCOPES;
  if (value === undefined || value.trim().length === 0) {
    return ["platform.read"];
  }
  return value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await seedLiveSmokeAgentOAuth();
  console.log(JSON.stringify(result, null, 2));
}
