import { pathToFileURL } from "node:url";
import { hashPassword } from "@better-auth/utils/password";
import type postgres from "postgres";
import { createSqlClient } from "./client.js";
import { DEFAULT_LOCAL_OAUTH_ORG_ID } from "./seed-local-oauth.js";

/**
 * Seeds two real email/password login accounts for the web app.
 *
 * Each account is a fully-linked trio:
 *   1. an `actors` row (type='user') whose `scopes` drive authorization,
 *   2. a Better-Auth `"user"` row linked back to the actor via `actor_id`,
 *   3. a Better-Auth `account` row holding the hashed credential password.
 *
 * The actor metadata also carries `betterAuth.userId` so the backend's
 * `findUserActorByBetterAuthId` resolver links the session to the actor.
 *
 * Idempotent: re-running repairs/relinks existing rows. Orphaned Better-Auth
 * users sharing an account email (e.g. a prior sign-up with actorId=null) are
 * deleted and recreated correctly linked.
 */

export const LOGIN_SEED_SOURCE = "login-seed";

const ADMIN_SCOPES = [
  "platform.read",
  "mail.read",
  "mail.write",
  "mail.send",
  "mail.external",
  "mail.admin",
  "drive.read",
  "drive.write",
  "drive.delete",
  "docs.read",
  "docs.write",
  "docs.comment",
  "calendar.read",
  "calendar.write",
  "calendar.external",
  "chat.read",
  "chat.write",
  "chat.post",
  "chat.create",
  "meet.read",
  "meet.write",
  "assistant.read",
  "assistant.write",
  "assistant.memory",
  "sheets.read",
  "sheets.write",
  "slides.read",
  "slides.write",
  "notifications.read",
  "notifications.write",
  "search.read",
  "tools:read",
  "tools:write",
  "webhooks.read",
  "webhooks.write",
  "admin",
  "admin.users",
  "admin.audit",
  "admin.agents",
  "admin.plugins",
  "admin.webhooks",
  "admin.config.read",
  "admin.config.write",
  "admin.console.read",
  "admin.console.write",
  "admin.ai",
] as const;

const USER_SCOPES = [
  "platform.read",
  "mail.read",
  "mail.write",
  "mail.send",
  "drive.read",
  "drive.write",
  "docs.read",
  "docs.write",
  "calendar.read",
  "calendar.write",
  "chat.read",
  "chat.write",
  "meet.read",
  "meet.write",
  "assistant.read",
  "assistant.write",
  "assistant.memory",
  "sheets.read",
  "sheets.write",
  "slides.read",
  "slides.write",
  "search.read",
] as const;

interface LoginAccountSpec {
  readonly key: "admin" | "user";
  readonly actorId: string;
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly scopes: readonly string[];
}

const LOGIN_ACCOUNTS: readonly LoginAccountSpec[] = [
  {
    key: "admin",
    actorId: "00000000-0000-4000-8000-000000000110",
    email: "admin@helix.local",
    password: "helix-admin-password",
    displayName: "Avery Park",
    scopes: ADMIN_SCOPES,
  },
  {
    key: "user",
    actorId: "00000000-0000-4000-8000-000000000111",
    email: "user@helix.local",
    password: "helix-user-password",
    displayName: "Riley Chen",
    scopes: USER_SCOPES,
  },
];

export interface SeededLoginAccount {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly actorId: string;
  readonly betterAuthUserId: string;
  readonly admin: boolean;
}

export interface SeedLoginAccountsResult {
  readonly orgId: string;
  readonly accounts: readonly SeededLoginAccount[];
}

type SeedSql = postgres.Sql | postgres.TransactionSql;

export async function seedLoginAccounts(
  sql: postgres.Sql,
  options: { readonly orgId?: string } = {},
): Promise<SeedLoginAccountsResult> {
  const orgId = options.orgId ?? DEFAULT_LOCAL_OAUTH_ORG_ID;
  const accounts: SeededLoginAccount[] = [];

  for (const spec of LOGIN_ACCOUNTS) {
    const passwordHash = await hashPassword(spec.password);
    const betterAuthUserId = `login-${spec.actorId}`;
    await sql.begin(async (tx) => {
      await upsertActor(tx, orgId, spec, betterAuthUserId);
      await repairOrphanedBetterAuthUsers(tx, spec.email, betterAuthUserId);
      await upsertBetterAuthUser(tx, betterAuthUserId, spec);
      await upsertCredentialAccount(tx, betterAuthUserId, passwordHash);
    });
    accounts.push({
      email: spec.email,
      password: spec.password,
      displayName: spec.displayName,
      actorId: spec.actorId,
      betterAuthUserId,
      admin: spec.key === "admin",
    });
  }

  return { orgId, accounts };
}

async function upsertActor(
  sql: SeedSql,
  orgId: string,
  spec: LoginAccountSpec,
  betterAuthUserId: string,
): Promise<void> {
  const metadata = {
    source: LOGIN_SEED_SOURCE,
    betterAuth: { userId: betterAuthUserId, emailVerified: true },
  };
  await sql`
    insert into actors (id, org_id, type, email, display_name, scopes, disabled_at, metadata)
    values (
      ${spec.actorId},
      ${orgId},
      'user',
      ${spec.email},
      ${spec.displayName},
      ${sql.array([...spec.scopes], 1009)},
      null,
      ${sql.json(metadata)}
    )
    on conflict (id) do update
    set
      org_id = excluded.org_id,
      type = 'user',
      email = excluded.email,
      display_name = excluded.display_name,
      scopes = excluded.scopes,
      disabled_at = null,
      metadata = actors.metadata || excluded.metadata,
      updated_at = now()
  `;
}

/**
 * Removes any pre-existing Better-Auth `"user"` rows that collide on email but
 * are not the canonical seed user (e.g. an orphaned sign-up with actorId=null).
 * Their dependent `account`/`session` rows are cleared first.
 */
async function repairOrphanedBetterAuthUsers(
  sql: SeedSql,
  email: string,
  canonicalUserId: string,
): Promise<void> {
  const orphans = await sql<{ readonly id: string }[]>`
    select id from "user"
    where lower(email) = ${email.toLowerCase()}
      and id <> ${canonicalUserId}
  `;
  if (orphans.length === 0) {
    return;
  }
  const ids = orphans.map((row) => row.id);
  await sql`delete from account where "userId" = any(${sql.array(ids)})`;
  await sql`delete from session where "userId" = any(${sql.array(ids)})`;
  await sql`delete from "user" where id = any(${sql.array(ids)})`;
}

async function upsertBetterAuthUser(
  sql: SeedSql,
  userId: string,
  spec: LoginAccountSpec,
): Promise<void> {
  await sql`
    insert into "user" (id, name, email, "emailVerified", actor_id, "createdAt", "updatedAt")
    values (${userId}, ${spec.displayName}, ${spec.email}, true, ${spec.actorId}, now(), now())
    on conflict (id) do update
    set
      name = excluded.name,
      email = excluded.email,
      "emailVerified" = true,
      actor_id = excluded.actor_id,
      "updatedAt" = now()
  `;
}

async function upsertCredentialAccount(
  sql: SeedSql,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await sql`
    insert into account (
      id, "userId", "accountId", "providerId", password, "createdAt", "updatedAt"
    )
    values (
      ${`${userId}-credential`},
      ${userId},
      ${userId},
      'credential',
      ${passwordHash},
      now(),
      now()
    )
    on conflict ("providerId", "accountId") do update
    set
      "userId" = excluded."userId",
      password = excluded.password,
      "updatedAt" = now()
  `;
}

async function main(): Promise<void> {
  const sql = createSqlClient();
  try {
    const result = await seedLoginAccounts(sql);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
