import { hashPassword } from "better-auth/crypto";
import type { SecurityScanResult } from "@helix/contracts";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import type postgres from "postgres";
import { env, loadSeedEnv } from "../config/env.js";
import { createClamAvVirusScanner, type VirusScanner } from "../platform/drive/scanning.js";
import { PostgresDriveStore, type DriveStorageClient } from "../platform/drive/store.js";
import { createS3CompatibleStorage } from "../platform/storage/index.js";
import { createTenantStorageResolver } from "../platform/storage/tenant-resolver.js";
import { isJsonObject, type JsonObject } from "@helix/sdk-types";
import { withTenantPostgresContext } from "../platform/tenancy/postgres-roles.js";
import { createSqlClient, resolveDatabaseUrl } from "./client.js";
import { DEFAULT_LOCAL_OAUTH_ORG_ID } from "./seed-local-oauth.js";
import {
  LOCAL_TEAM_GROUPS,
  LOCAL_TEAM_PASSWORD,
  LOCAL_TEAM_PEOPLE,
  LOCAL_TEAM_ROOMS,
  LOCAL_TEAM_SCOPES,
  LOCAL_TEAM_SOURCE,
  teamDay,
  teamFileFixtures,
} from "./local-team-fixtures.js";
import { seedTeamContent } from "./seed-local-team-content.js";
import { seedLocalTeamDomain } from "./seed-local-team-domain.js";

interface TeamSeedOptions {
  readonly orgId?: string;
  readonly password?: string;
  readonly anchorDate?: string;
  readonly accountsOnly?: boolean;
  readonly storage?: DriveStorageClient & { ensureBucket?(): Promise<void> };
  readonly scanner?: VirusScanner;
}

export async function seedLocalTeam(sql: postgres.Sql, options: TeamSeedOptions = {}) {
  assertLocalTeamTarget(resolveDatabaseUrl());
  const orgId = options.orgId ?? DEFAULT_LOCAL_OAUTH_ORG_ID;
  const anchorDate = options.anchorDate ?? new Date().toISOString().slice(0, 10);
  teamDay(anchorDate, 0);
  const password = options.password ?? LOCAL_TEAM_PASSWORD;
  if (
    !options.accountsOnly &&
    (options.storage === undefined || options.scanner?.kind !== "clamav")
  ) {
    throw new Error("Team content requires real object storage and a ClamAV scanner.");
  }
  const accounts = LOCAL_TEAM_PEOPLE.map((person) => ({
    actorId: person.actorId,
    email: person.email,
    displayName: person.displayName,
    password,
  }));
  // A reserved connection keeps the advisory lock for the entire seed, including S3 I/O.
  const lock = await sql.reserve();
  try {
    await lock`select pg_advisory_lock(hashtextextended(${`${orgId}:${LOCAL_TEAM_SOURCE}`}, 0))`;
    await withTenantPostgresContext(sql, { orgId }, async (tx) => {
      const org = await tx`select id from orgs where id = ${orgId}`;
      if (org.length !== 1)
        throw new Error("Seed the local workspace organization before adding team accounts.");
      await assertTeamIdentityNamespace(tx, orgId);
      for (const person of LOCAL_TEAM_PEOPLE) {
        const existing = await tx`select id from actors where id = ${person.actorId}`;
        if (existing.length > 0) continue; // Keep edited names, profiles, scopes, and credentials intact.
        const userId = `local-team-${person.actorId}`;
        const passwordHash = await hashPassword(password);
        await tx`insert into actors (id, org_id, type, email, display_name, scopes, metadata)
          values (${person.actorId}, ${orgId}, 'user', ${person.email}, ${person.displayName}, ${tx.array([...LOCAL_TEAM_SCOPES], 1009)},
            ${tx.json({ source: LOCAL_TEAM_SOURCE, profile: { pronouns: person.pronouns, jobTitle: person.jobTitle, about: person.about } })})`;
        await tx`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
          values (${userId}, ${person.displayName}, ${person.email}, true, now(), now())`;
        await tx`insert into account (id, "userId", "accountId", "providerId", issuer, password, "createdAt", "updatedAt")
          values (${`${userId}-credential`}, ${userId}, ${userId}, 'credential', 'local:credential', ${passwordHash}, now(), now())`;
        const linked = await tx<
          { actor_id: string | null }[]
        >`select helix_activate_identity_membership(
          'better-auth', ${userId}, ${orgId}, ${person.email}, ${person.displayName}) as actor_id`;
        if (linked[0]?.actor_id !== person.actorId)
          throw new Error(`Team identity activation failed for ${person.email}.`);
      }
      const owner = LOCAL_TEAM_PEOPLE[0];
      if (owner) await seedLocalTeamDomain(tx, orgId, owner.actorId);
      for (const person of LOCAL_TEAM_PEOPLE) {
        for (const alias of person.aliases) {
          await tx`insert into mail_aliases (org_id, actor_id, email, display_name, is_primary, receive_enabled, send_as_enabled)
            select ${orgId}, ${person.actorId}, ${alias}, ${person.displayName}, false, true, true
            where not exists (
              select 1 from mail_aliases
              where org_id = ${orgId} and email = ${alias} and disabled_at is null
            )`;
        }
      }
      await tx`update orgs set byo_config = jsonb_set(byo_config, '{storage}', '{"kind":"helix-default","prefix":""}'::jsonb)
        where id = ${orgId} and not (byo_config ? 'storage')`;
    });
    const files: {
      key: string;
      objectId: string;
      ownerActorId: string;
      folderId: string | null;
      name: string;
    }[] = [];
    const scanEvidence: SecurityScanResult[] = [];
    if (!options.accountsOnly) {
      if (options.storage === undefined || options.scanner === undefined)
        throw new Error("Team content dependencies are missing.");
      await options.storage.ensureBucket?.();
      await withTenantPostgresContext(sql, { orgId }, (tx) =>
        seedTeamContent(tx, orgId, anchorDate),
      );
      const sourceScanner = options.scanner;
      const drive = new PostgresDriveStore(sql, options.storage, {
        virusScanner: {
          kind: "clamav",
          async scan(bytes) {
            const result = await sourceScanner.scan(bytes);
            if (result.securityScan) scanEvidence.push(result.securityScan);
            return result;
          },
        },
        requireVirusScanner: true,
      });
      for (const fixture of teamFileFixtures()) {
        const existing = await withTenantPostgresContext(
          sql,
          { orgId, actorId: fixture.owner.actorId },
          (tx) => tx<{ id: string; storage_key: string; metadata: { status?: string } }[]>`
          select id, storage_key, metadata from objects where org_id = ${orgId} and metadata->>'source' = ${LOCAL_TEAM_SOURCE}
            and metadata->>'seedKey' = ${fixture.key}`,
        );
        if (existing.length > 1) throw new Error(`Duplicate team file fixture: ${fixture.key}.`);
        let objectId = existing[0]?.id;
        let storageKey = existing[0]?.storage_key;
        if (objectId === undefined) {
          const upload = await drive.prepareUpload({
            orgId,
            actorId: fixture.owner.actorId,
            name: fixture.name,
            folderId: fixture.folderId,
            mimeType: fixture.mimeType,
            byteSize: Buffer.byteLength(fixture.body),
            metadata: { source: LOCAL_TEAM_SOURCE, seedKey: fixture.key },
          });
          objectId = upload.objectId;
          storageKey = upload.storageKey;
        }
        if (existing[0]?.metadata.status !== "ready") {
          if (storageKey === undefined) throw new Error("Pending fixture storage key is missing.");
          await options.storage.put({
            key: storageKey,
            body: Buffer.from(fixture.body),
            contentType: fixture.mimeType,
          });
          await drive.finalizeUpload({
            orgId,
            actorId: fixture.owner.actorId,
            objectId,
            byteSize: Buffer.byteLength(fixture.body),
            mimeType: fixture.mimeType,
            idempotencyKey: `${LOCAL_TEAM_SOURCE}:${fixture.key}`,
            metadata: { source: LOCAL_TEAM_SOURCE, seedKey: fixture.key },
          });
        }
        files.push({
          key: fixture.key,
          objectId,
          ownerActorId: fixture.owner.actorId,
          folderId: fixture.folderId,
          name: fixture.name,
        });
      }
    }
    return {
      source: LOCAL_TEAM_SOURCE,
      orgId,
      anchorDate,
      accounts,
      files,
      scanEvidence,
      rooms: LOCAL_TEAM_ROOMS,
      groups: LOCAL_TEAM_GROUPS,
      warning:
        "Local fictional demo credentials only. Reruns retain existing passwords and user edits. Saved Assistant replies are synthetic examples, not live model output.",
    };
  } finally {
    await lock`select pg_advisory_unlock(hashtextextended(${`${orgId}:${LOCAL_TEAM_SOURCE}`}, 0))`;
    lock.release();
  }
}

async function assertTeamIdentityNamespace(sql: postgres.TransactionSql, orgId: string) {
  const actors = await sql<
    { id: string; org_id: string; email: string | null; source: string | null }[]
  >`
    select id, org_id, email, metadata->>'source' as source from actors
    where id = any(${sql.array(
      LOCAL_TEAM_PEOPLE.map((person) => person.actorId),
      2950,
    )})
      or lower(email) = any(${sql.array(
        LOCAL_TEAM_PEOPLE.map((person) => person.email),
        1009,
      )})`;
  for (const actor of actors) {
    const spec = LOCAL_TEAM_PEOPLE.find((person) => person.actorId === actor.id);
    if (
      !spec ||
      actor.org_id !== orgId ||
      actor.email?.toLowerCase() !== spec.email ||
      actor.source !== LOCAL_TEAM_SOURCE
    ) {
      throw new Error(
        "Team seed actor IDs or emails collide with existing data; nothing was replaced.",
      );
    }
  }
  const identities = await sql<{ id: string; email: string }[]>`select id, email from "user"
    where lower(email) = any(${sql.array(
      LOCAL_TEAM_PEOPLE.map((person) => person.email),
      1009,
    )})`;
  for (const identity of identities) {
    const spec = LOCAL_TEAM_PEOPLE.find((person) => person.email === identity.email.toLowerCase());
    if (
      !spec ||
      identity.id !== `local-team-${spec.actorId}` ||
      !actors.some((actor) => actor.id === spec.actorId)
    ) {
      throw new Error("Team seed emails collide with an existing login; nothing was replaced.");
    }
  }
}

export function localTeamStorage() {
  const config = loadSeedEnv();
  const endpoint = config.RUSTFS_ENDPOINT;
  if (endpoint === undefined) throw new Error("RUSTFS_ENDPOINT is required for the team seed.");
  assertLoopback(endpoint);
  const encryption = config.RUSTFS_SERVER_SIDE_ENCRYPTION;
  if (encryption !== undefined && encryption !== "AES256" && encryption !== "aws:kms")
    throw new Error("Unsupported local storage encryption mode.");
  return createS3CompatibleStorage({
    endpoint,
    region: config.RUSTFS_REGION ?? "us-east-1",
    bucket: config.RUSTFS_BUCKET ?? "helix-objects",
    credentials: {
      accessKeyId: config.RUSTFS_ACCESS_KEY ?? "helixrustfs",
      secretAccessKey: config.RUSTFS_SECRET_KEY ?? "helix_rustfs_dev_secret",
    },
    forcePathStyle: true,
    ...(encryption === undefined ? {} : { serverSideEncryption: encryption }),
    ...(config.RUSTFS_SSE_KMS_KEY_ID === undefined
      ? {}
      : { serverSideEncryptionAwsKmsKeyId: config.RUSTFS_SSE_KMS_KEY_ID }),
  });
}

export async function localTeamResolvedStorage(sql: postgres.Sql) {
  const raw = localTeamStorage();
  const encryption = loadSeedEnv().RUSTFS_SERVER_SIDE_ENCRYPTION;
  const orgId = DEFAULT_LOCAL_OAUTH_ORG_ID;
  const resolver = createTenantStorageResolver({
    defaultClient: raw,
    ...(encryption === "AES256" || encryption === "aws:kms"
      ? { defaultServerSideEncryption: encryption }
      : {}),
    loadByoConfig: () =>
      withTenantPostgresContext(sql, { orgId }, async (tx) => {
        const [org] = await tx<
          { byo_config: JsonObject }[]
        >`select byo_config from orgs where id = ${orgId}`;
        const storage = org?.byo_config.storage;
        if (storage !== undefined && (!isJsonObject(storage) || storage.kind !== "helix-default"))
          throw new Error(
            "Team seed supports local Helix-default storage only; existing tenant storage was preserved.",
          );
        return storage === undefined
          ? { storage: { kind: "helix-default", prefix: "" } }
          : org?.byo_config;
      }),
  });
  const resolved = await resolver({ orgId });
  if (!resolved) throw new Error("Local tenant object storage is unavailable.");
  return { ...resolved.client, ensureBucket: () => raw.ensureBucket() };
}

export function assertLocalTeamTarget(databaseUrl = resolveDatabaseUrl()) {
  if (env().NODE_ENV === "production")
    throw new Error("Team demo seeding is local-development only.");
  assertLoopback(databaseUrl);
}

function assertLoopback(address: string) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(address).hostname)) {
    throw new Error(
      "Team demo seeding only accepts loopback database and object-storage endpoints.",
    );
  }
}

async function main() {
  assertLocalTeamTarget();
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  let accountsOnly = false;
  let output: string | undefined;
  let anchorDate: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--accounts-only") accountsOnly = true;
    else if (arg === "--output" && args[index + 1]) output = args[++index];
    else if (arg === "--anchor-date" && args[index + 1]) anchorDate = args[++index];
    else
      throw new Error(
        "Usage: db:seed:team [--accounts-only] [--anchor-date YYYY-MM-DD] [--output path]",
      );
  }
  const sql = createSqlClient();
  try {
    const result = await seedLocalTeam(sql, {
      accountsOnly,
      ...(anchorDate ? { anchorDate } : {}),
      ...(accountsOnly
        ? {}
        : {
            storage: await localTeamResolvedStorage(sql),
            scanner: createClamAvVirusScanner({ host: "127.0.0.1", port: 28460, tier: "business" }),
          }),
    });
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (output) {
      await writeFile(output, serialized, { mode: 0o600 });
      console.log(
        `Team demo ready: ${String(result.accounts.length)} accounts, ${String(result.files.length)} files. Login handoff: ${output}`,
      );
    } else console.log(serialized);
  } finally {
    await sql.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
