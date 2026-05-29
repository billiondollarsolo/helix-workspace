import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { verifyPassword } from "@better-auth/utils/password";
import type postgres from "postgres";
import type { StorageClient, StorageObject } from "@helix/sdk-types";
import { createSqlClient } from "./client.js";
import {
  createLocalDemoSearchEngineFromEnv,
  localDemoSearchDocumentsForAnchor,
  LOCAL_DEMO_SEARCH_DOCUMENTS,
  type LocalDemoSearchDocumentDescriptor,
} from "./index-local-demo-search.js";
import {
  DEFAULT_LOCAL_OAUTH_ACTOR_ID,
  DEFAULT_LOCAL_OAUTH_CLIENT_ID,
  DEFAULT_LOCAL_OAUTH_EMAIL,
  DEFAULT_LOCAL_OAUTH_ORG_ID,
} from "./seed-local-oauth.js";
import {
  createDemoTimeline,
  DEFAULT_LOCAL_DEMO_PASSWORD,
  LOCAL_DEMO_IDS,
} from "./seed-local-demo.js";
import { LOCAL_DEMO_VOLUME_MAIL_MARKER, LOCAL_DEMO_VOLUME_SOURCE } from "./seed-local-demo.js";
import {
  createBetterAuthPlatformModule,
  createBetterAuthRuntime,
  createBetterAuthSessionActorResolver,
  PostgresBetterAuthActorStore,
  PostgresBetterAuthUserLinkStore,
} from "../platform/auth/better-auth.js";
import { createS3CompatibleStorage } from "../platform/storage/index.js";
import { PostgresCalendarStore } from "../platform/calendar/index.js";
import { PostgresChatStore } from "../platform/chat/index.js";
import { PostgresDocsStore } from "../platform/docs/index.js";
import { PostgresDriveStore } from "../platform/drive/index.js";
import { PostgresMailStore } from "../platform/mail/index.js";
import type { SearchEngine } from "../platform/search/index.js";

export interface VerifyLocalDemoOptions {
  readonly orgId?: string;
  readonly actorId?: string;
  readonly clientId?: string;
  readonly email?: string;
  readonly password?: string;
  readonly anchorDate?: string | Date | undefined;
  readonly storage?: StorageClient;
  readonly searchEngine?: SearchEngine;
}

export interface LocalDemoVerificationSnapshot {
  readonly orgCount: number;
  readonly actorCount: number;
  readonly hasDocsCommentScope: boolean;
  readonly betterAuthUserCount: number;
  readonly betterAuthCredentialCount: number;
  readonly oauthCredentialCount: number;
  readonly mailHitCount: number;
  readonly mailThreadMessageCount: number;
  readonly docsCount: number;
  readonly rootDriveEntryCount: number;
  readonly projectDriveEntryCount: number;
  readonly calendarEventCount: number;
  readonly chatRoomCount: number;
  readonly chatMessageHitCount: number;
  readonly hasRenovateMail: boolean;
  readonly hasAmazonMailWithAttachment: boolean;
  readonly hasQuarterlyPlanningDoc: boolean;
  readonly hasAiServicesDriveFile: boolean;
  readonly hasProjectsDriveFolder: boolean;
  readonly hasTrainingCourseDriveFile: boolean;
  readonly hasOrderMatchCalendarEvent: boolean;
  readonly hasProductPlanningCalendarEvent: boolean;
  readonly hasLaunchChatRoom: boolean;
  readonly hasMailDensityChatMessage: boolean;
  readonly betterAuthPasswordVerified: boolean;
  readonly betterAuthSignInVerified: boolean;
  readonly storageConfigured: boolean;
  readonly storageObjectCount: number;
  readonly storageObjectsVerified: boolean;
  readonly searchConfigured: boolean;
  readonly searchHitCount: number;
  readonly searchResultsVerified: boolean;
  readonly curatedSearchDocumentCount: number;
  readonly curatedSearchDocumentsVerified: boolean;
  readonly curatedSearchProjectionFailures: readonly string[];
  readonly volumeMailMessageCount: number;
  readonly volumeMailThreadCount: number;
  readonly volumeSearchHitCount: number;
  readonly volumeSearchResultsVerified: boolean;
}

export interface LocalDemoVerificationResult extends LocalDemoVerificationSnapshot {
  readonly ok: true;
  readonly orgId: string;
  readonly actorId: string;
}

export async function verifyLocalDemo(
  sql: postgres.Sql,
  options: VerifyLocalDemoOptions = {},
): Promise<LocalDemoVerificationResult> {
  const orgId = options.orgId ?? DEFAULT_LOCAL_OAUTH_ORG_ID;
  const actorId = options.actorId ?? DEFAULT_LOCAL_OAUTH_ACTOR_ID;
  const clientId = options.clientId ?? DEFAULT_LOCAL_OAUTH_CLIENT_ID;
  const email = options.email ?? DEFAULT_LOCAL_OAUTH_EMAIL;
  const password =
    options.password ?? process.env.HELIX_LOCAL_DEMO_PASSWORD ?? DEFAULT_LOCAL_DEMO_PASSWORD;
  const timeline = createDemoTimeline(options.anchorDate);
  const storage = options.storage ?? createLocalDemoStorageFromEnv();
  const searchEngine = options.searchEngine ?? (await createLocalDemoSearchEngineFromEnv());
  const mailStore = new PostgresMailStore(sql);
  const docsStore = new PostgresDocsStore(sql);
  const driveStore = new PostgresDriveStore(sql);
  const calendarStore = new PostgresCalendarStore(sql);
  const chatStore = new PostgresChatStore(sql);

  const [
    orgRows,
    actorRows,
    betterAuthRows,
    betterAuthCredentialRows,
    credentialRows,
    renovateMailHits,
    amazonMailHits,
    mailThread,
    docs,
    rootDriveEntries,
    projectDriveEntries,
    trainingDriveHits,
    calendarEvents,
    chatRooms,
    chatHits,
  ] = await Promise.all([
    sql<{ readonly id: string }[]>`
        select id from orgs
        where id = ${orgId}
          and status = 'active'
        limit 1
      `,
    sql<{ readonly id: string; readonly scopes: readonly string[] }[]>`
        select id, scopes from actors
        where org_id = ${orgId}
          and id = ${actorId}
          and disabled_at is null
        limit 1
      `,
    sql<{ readonly id: string }[]>`
        select id from "user"
        where actor_id = ${actorId}
        limit 1
      `,
    sql<{ readonly password: string | null }[]>`
        select account.password
        from account
        join "user" on "user".id = account."userId"
        where "user".actor_id = ${actorId}
          and account."providerId" = 'credential'
          and account.password is not null
        limit 1
      `,
    sql<{ readonly client_id: string }[]>`
        select client_id from agent_credentials
        where actor_id = ${actorId}
          and client_id = ${clientId}
          and revoked_at is null
        limit 1
      `,
    mailStore.search({ orgId, actorId, query: "Renovate", limit: 10 }),
    mailStore.search({ orgId, actorId, query: "Amazon", limit: 10 }),
    mailStore.getThread({ orgId, actorId, threadId: LOCAL_DEMO_IDS.mailAmazonThread }),
    docsStore.listDocumentsForActor({ orgId, actorId, query: "Quarterly", limit: 10 }),
    driveStore.list({ orgId, actorId, limit: 25 }),
    driveStore.list({
      orgId,
      actorId,
      folderId: LOCAL_DEMO_IDS.driveFolderProjects,
      limit: 25,
    }),
    driveStore.search({ orgId, actorId, query: "Training Course", limit: 10 }),
    calendarStore.listCalendarEventsForActor({
      orgId,
      actorId,
      startsAt: timeline.at("2026-05-20T00:00:00.000Z"),
      endsAt: timeline.at("2026-05-22T00:00:00.000Z"),
      limit: 10,
    }),
    chatStore.listRooms({ orgId, actorId, query: "Helix launch", limit: 10 }),
    chatStore.search({ orgId, actorId, query: "Mail density", limit: 10 }),
  ]);
  const volumeCounts = await countVolumeMail(sql, orgId, actorId);
  const betterAuthPasswordVerified =
    betterAuthCredentialRows[0]?.password === null ||
    betterAuthCredentialRows[0]?.password === undefined
      ? false
      : await verifyPassword(betterAuthCredentialRows[0].password, password);
  const betterAuthSignInVerified = await verifyBetterAuthSignIn(sql, {
    orgId,
    actorId,
    email,
    password,
  });
  const storageVerification = await verifySeededStorageObjects(sql, orgId, storage);
  const searchVerification = await verifySeededSearch(searchEngine, orgId, options.anchorDate);
  const volumeSearchVerification = await verifyVolumeSearch(
    searchEngine,
    orgId,
    volumeCounts.messages,
  );

  const snapshot = {
    orgCount: orgRows.length,
    actorCount: actorRows.length,
    hasDocsCommentScope: actorRows.some((actor) => actor.scopes.includes("docs.comment")),
    betterAuthUserCount: betterAuthRows.length,
    betterAuthCredentialCount: betterAuthCredentialRows.length,
    oauthCredentialCount: credentialRows.length,
    mailHitCount: renovateMailHits.length + amazonMailHits.length,
    mailThreadMessageCount: mailThread?.messages.length ?? 0,
    docsCount: docs.length,
    rootDriveEntryCount: rootDriveEntries.length,
    projectDriveEntryCount: projectDriveEntries.length,
    calendarEventCount: calendarEvents.length,
    chatRoomCount: chatRooms.length,
    chatMessageHitCount: chatHits.length,
    hasRenovateMail: renovateMailHits.some((hit) => hit.subject.includes("Renovate")),
    hasAmazonMailWithAttachment:
      amazonMailHits.some((hit) => hit.subject.includes("Amazon")) &&
      (mailThread?.messages.some((message) => message.hasAttachment) ?? false),
    hasQuarterlyPlanningDoc: docs.some((doc) => doc.title === "Quarterly Planning Notes"),
    hasAiServicesDriveFile: rootDriveEntries.some((entry) => entry.name === "AI Services and Keys"),
    hasProjectsDriveFolder: rootDriveEntries.some(
      (entry) => entry.name === "Projects" && entry.type === "folder",
    ),
    hasTrainingCourseDriveFile:
      projectDriveEntries.some((entry) => entry.name === "Training Course Links") ||
      trainingDriveHits.some((hit) => hit.name === "Training Course Links"),
    hasOrderMatchCalendarEvent: calendarEvents.some((event) => event.title === "Order match ball"),
    hasProductPlanningCalendarEvent: calendarEvents.some(
      (event) => event.title === "Product planning review",
    ),
    hasLaunchChatRoom: chatRooms.some((room) => room.id === LOCAL_DEMO_IDS.chatRoomLaunch),
    hasMailDensityChatMessage: chatHits.some(
      (hit) => hit.messageId === LOCAL_DEMO_IDS.chatMessageMailDensity,
    ),
    betterAuthPasswordVerified,
    betterAuthSignInVerified,
    storageConfigured: storage !== undefined,
    storageObjectCount: storageVerification.count,
    storageObjectsVerified: storageVerification.verified,
    searchConfigured: searchEngine !== undefined,
    searchHitCount: searchVerification.count,
    searchResultsVerified: searchVerification.verified,
    curatedSearchDocumentCount: searchVerification.count,
    curatedSearchDocumentsVerified: searchVerification.verified,
    curatedSearchProjectionFailures: searchVerification.failures,
    volumeMailMessageCount: volumeCounts.messages,
    volumeMailThreadCount: volumeCounts.threads,
    volumeSearchHitCount: volumeSearchVerification.count,
    volumeSearchResultsVerified: volumeSearchVerification.verified,
  } satisfies LocalDemoVerificationSnapshot;
  assertLocalDemoVerified(snapshot);
  return { ok: true, orgId, actorId, ...snapshot };
}

export function assertLocalDemoVerified(snapshot: LocalDemoVerificationSnapshot): void {
  const failures: string[] = [];
  requireAtLeast(failures, "local demo org", snapshot.orgCount, 1);
  requireAtLeast(failures, "actor", snapshot.actorCount, 1);
  requireTrue(failures, "Docs comment/suggestion scope", snapshot.hasDocsCommentScope);
  requireAtLeast(failures, "Better Auth user linkage", snapshot.betterAuthUserCount, 1);
  requireAtLeast(failures, "Better Auth credential", snapshot.betterAuthCredentialCount, 1);
  requireAtLeast(failures, "OAuth credential", snapshot.oauthCredentialCount, 1);
  requireAtLeast(failures, "mail search hits", snapshot.mailHitCount, 1);
  requireAtLeast(failures, "mail thread messages", snapshot.mailThreadMessageCount, 1);
  requireAtLeast(failures, "docs list results", snapshot.docsCount, 1);
  requireAtLeast(failures, "root Drive entries", snapshot.rootDriveEntryCount, 2);
  requireAtLeast(failures, "project Drive entries", snapshot.projectDriveEntryCount, 1);
  requireAtLeast(failures, "calendar events", snapshot.calendarEventCount, 2);
  requireAtLeast(failures, "chat rooms", snapshot.chatRoomCount, 1);
  requireAtLeast(failures, "chat message hits", snapshot.chatMessageHitCount, 1);
  requireTrue(failures, "Renovate mail", snapshot.hasRenovateMail);
  requireTrue(failures, "Amazon mail attachment", snapshot.hasAmazonMailWithAttachment);
  requireTrue(failures, "Quarterly Planning Notes doc", snapshot.hasQuarterlyPlanningDoc);
  requireTrue(failures, "AI Services and Keys Drive file", snapshot.hasAiServicesDriveFile);
  requireTrue(failures, "Projects Drive folder", snapshot.hasProjectsDriveFolder);
  requireTrue(failures, "Training Course Links Drive file", snapshot.hasTrainingCourseDriveFile);
  requireTrue(failures, "Order match ball calendar event", snapshot.hasOrderMatchCalendarEvent);
  requireTrue(
    failures,
    "Product planning review calendar event",
    snapshot.hasProductPlanningCalendarEvent,
  );
  requireTrue(failures, "Helix launch chat room", snapshot.hasLaunchChatRoom);
  requireTrue(failures, "Mail density chat message", snapshot.hasMailDensityChatMessage);
  requireTrue(failures, "Better Auth email/password login", snapshot.betterAuthPasswordVerified);
  requireTrue(failures, "Better Auth session login", snapshot.betterAuthSignInVerified);
  if (snapshot.storageConfigured) {
    requireAtLeast(failures, "seeded storage objects", snapshot.storageObjectCount, 5);
    requireTrue(failures, "seeded storage object content", snapshot.storageObjectsVerified);
  }
  if (snapshot.volumeMailMessageCount > 0) {
    requireAtLeast(
      failures,
      "volume mail threads",
      snapshot.volumeMailThreadCount,
      snapshot.volumeMailMessageCount,
    );
  }
  if (snapshot.searchConfigured) {
    requireAtLeast(
      failures,
      "seeded search hits",
      snapshot.searchHitCount,
      LOCAL_DEMO_SEARCH_DOCUMENTS.length,
    );
    requireTrue(failures, "seeded search results", snapshot.searchResultsVerified);
    requireAtLeast(
      failures,
      "curated search documents",
      snapshot.curatedSearchDocumentCount,
      LOCAL_DEMO_SEARCH_DOCUMENTS.length,
    );
    requireTrue(
      failures,
      "curated search document projections",
      snapshot.curatedSearchDocumentsVerified,
    );
    if (snapshot.curatedSearchProjectionFailures.length > 0) {
      failures.push(
        `curated search projection failures: ${snapshot.curatedSearchProjectionFailures.join(", ")}`,
      );
    }
    if (snapshot.volumeMailMessageCount > 0) {
      requireAtLeast(
        failures,
        "volume mail search hits",
        snapshot.volumeSearchHitCount,
        Math.min(snapshot.volumeMailMessageCount, LOCAL_DEMO_VOLUME_SEARCH_LIMIT),
      );
      requireTrue(failures, "volume mail search results", snapshot.volumeSearchResultsVerified);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Local demo verification failed: ${failures.join("; ")}`);
  }
}

async function countVolumeMail(
  sql: postgres.Sql,
  orgId: string,
  actorId: string,
): Promise<{ readonly messages: number; readonly threads: number }> {
  const [messageRows, threadRows] = await Promise.all([
    sql<{ readonly count: string | number | bigint }[]>`
      select count(*) as count
      from messages m
      join mail_thread_state s on s.thread_id = m.thread_id
      where m.org_id = ${orgId}
        and m.kind = 'mail'
        and m.metadata->>'source' = ${LOCAL_DEMO_VOLUME_SOURCE}
        and s.actor_id = ${actorId}
        and s.deleted_at is null
    `,
    sql<{ readonly count: string | number | bigint }[]>`
      select count(*) as count
      from threads t
      join mail_thread_state s on s.thread_id = t.id
      where t.org_id = ${orgId}
        and t.kind = 'mail'
        and t.metadata->>'source' = ${LOCAL_DEMO_VOLUME_SOURCE}
        and s.actor_id = ${actorId}
        and s.deleted_at is null
    `,
  ]);
  return {
    messages: countValue(messageRows[0]?.count),
    threads: countValue(threadRows[0]?.count),
  };
}

async function verifyVolumeSearch(
  engine: SearchEngine | undefined,
  orgId: string,
  expectedMessages: number,
): Promise<{ readonly count: number; readonly verified: boolean }> {
  if (engine === undefined || expectedMessages === 0) {
    return { count: 0, verified: true };
  }
  const expected = Math.min(expectedMessages, LOCAL_DEMO_VOLUME_SEARCH_LIMIT);
  const deadline = Date.now() + 10_000;
  let lastCount = 0;
  while (Date.now() <= deadline) {
    const response = await engine.search({
      query: LOCAL_DEMO_VOLUME_MAIL_MARKER,
      types: ["mail"],
      filter: `attributes.orgId = ${JSON.stringify(orgId)}`,
      limit: LOCAL_DEMO_VOLUME_SEARCH_LIMIT,
    });
    const matchingHits = response.hits.filter((hit) => isExpectedVolumeSearchHit(hit, orgId));
    lastCount = matchingHits.length;
    if (matchingHits.length >= expected) {
      return { count: matchingHits.length, verified: true };
    }
    await delay(250);
  }
  return { count: lastCount, verified: false };
}

export function isExpectedVolumeSearchHit(
  hit: {
    readonly id: string;
    readonly type: string;
    readonly title?: string;
    readonly body?: string;
    readonly url?: string;
    readonly attributes?: Record<string, unknown>;
  },
  orgId: string,
): boolean {
  const attributes = hit.attributes ?? {};
  const metadata = attributes.metadata;
  return (
    hit.id.startsWith("mail:00000000-0000-4200-8000-") &&
    hit.type === "mail" &&
    hit.title?.includes(LOCAL_DEMO_VOLUME_MAIL_MARKER) === true &&
    hit.body?.includes(LOCAL_DEMO_VOLUME_MAIL_MARKER) === true &&
    typeof hit.url === "string" &&
    hit.url.startsWith("/mail/00000000-0000-4100-8000-") &&
    attributes.orgId === orgId &&
    typeof attributes.threadId === "string" &&
    attributes.threadId.startsWith("00000000-0000-4100-8000-") &&
    typeof attributes.messageId === "string" &&
    attributes.messageId.startsWith("00000000-0000-4200-8000-") &&
    includesString(attributes.labels, "volume") &&
    isRecord(metadata) &&
    metadata.source === LOCAL_DEMO_VOLUME_SOURCE &&
    metadata.marker === LOCAL_DEMO_VOLUME_MAIL_MARKER
  );
}

function countValue(value: string | number | bigint | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return value === undefined ? 0 : Number.parseInt(value, 10);
}

async function verifySeededSearch(
  engine: SearchEngine | undefined,
  orgId: string,
  anchorDate: string | Date | undefined,
): Promise<{
  readonly count: number;
  readonly verified: boolean;
  readonly failures: readonly string[];
}> {
  if (engine === undefined) {
    return { count: 0, verified: true, failures: [] };
  }
  const expectedDocuments = localDemoSearchDocumentsForAnchor(anchorDate);
  const deadline = Date.now() + 10_000;
  let lastCount = 0;
  let lastFailures: readonly string[] = [];
  while (Date.now() <= deadline) {
    let count = 0;
    const failures: string[] = [];
    for (const document of expectedDocuments) {
      const response = await engine.search({
        query: document.query,
        types: [document.type],
        filter: `attributes.orgId = ${JSON.stringify(orgId)}`,
        limit: 10,
      });
      if (response.hits.some((hit) => isExpectedDemoSearchHit(hit, document, orgId))) {
        count += 1;
      } else {
        failures.push(`${document.type}:${document.expectedTitle}`);
      }
    }
    lastCount = count;
    lastFailures = failures;
    if (count === expectedDocuments.length) {
      return { count, verified: true, failures: [] };
    }
    await delay(250);
  }
  return { count: lastCount, verified: false, failures: lastFailures };
}

function isExpectedDemoSearchHit(
  hit: {
    readonly id: string;
    readonly type: string;
    readonly title?: string;
    readonly body?: string;
    readonly url?: string;
    readonly attributes?: Record<string, unknown>;
  },
  document: LocalDemoSearchDocumentDescriptor,
  orgId: string,
): boolean {
  const attributes = hit.attributes ?? {};
  return (
    hit.id === document.expectedId &&
    hit.type === document.type &&
    hit.title === document.expectedTitle &&
    hit.url === document.expectedUrl &&
    bodyIncludes(hit.body, document.expectedBodyIncludes ?? []) &&
    attributes.orgId === orgId &&
    attributes[document.attributeIdKey] === document.recordId &&
    matchesSubset(attributes, document.expectedAttributes ?? {})
  );
}

function bodyIncludes(body: string | undefined, expectedParts: readonly string[]): boolean {
  if (expectedParts.length === 0) {
    return true;
  }
  return expectedParts.every((part) => body?.includes(part) === true);
}

function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.every((expectedItem) => actual.some((item) => matchesSubset(item, expectedItem)))
    );
  }
  if (isRecord(expected)) {
    return (
      isRecord(actual) &&
      Object.entries(expected).every(([key, expectedValue]) =>
        matchesSubset(actual[key], expectedValue),
      )
    );
  }
  return actual === expected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function includesString(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.some((item) => item === expected);
}

const LOCAL_DEMO_VOLUME_SEARCH_LIMIT = 20;

async function verifySeededStorageObjects(
  sql: postgres.Sql,
  orgId: string,
  storage: StorageClient | undefined,
): Promise<{ readonly count: number; readonly verified: boolean }> {
  if (storage === undefined) {
    return { count: 0, verified: true };
  }
  const rows = await sql<
    readonly { readonly storage_key: string; readonly sha256: string | null }[]
  >`
    select storage_key, sha256
    from objects
    where org_id = ${orgId}
      and id = any(${sql.array([...LOCAL_DEMO_STORAGE_OBJECT_IDS])}::uuid[])
    order by storage_key
  `;
  if (rows.length < LOCAL_DEMO_STORAGE_OBJECT_IDS.length) {
    return { count: rows.length, verified: false };
  }
  for (const row of rows) {
    if (row.sha256 === null) {
      return { count: rows.length, verified: false };
    }
    const object = await storage.get(row.storage_key);
    if (object === null) {
      return { count: rows.length, verified: false };
    }
    const body = await toUint8Array(object.body);
    const actualSha = createHash("sha256").update(body).digest("hex");
    if (actualSha !== row.sha256) {
      return { count: rows.length, verified: false };
    }
  }
  return { count: rows.length, verified: true };
}

const LOCAL_DEMO_STORAGE_OBJECT_IDS = [
  LOCAL_DEMO_IDS.driveFileAiServices,
  LOCAL_DEMO_IDS.driveFileTraining,
  LOCAL_DEMO_IDS.docsQuarterly,
  LOCAL_DEMO_IDS.docsRunbook,
  LOCAL_DEMO_IDS.mailAttachmentAmazon,
] as const;

async function verifyBetterAuthSignIn(
  sql: postgres.Sql,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly email: string;
    readonly password: string;
  },
): Promise<boolean> {
  const databaseUrl =
    process.env.BETTER_AUTH_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://helix:helix_dev_password@localhost:28432/helix";
  const baseUrl =
    process.env.BETTER_AUTH_URL ??
    process.env.HELIX_PUBLIC_URL ??
    process.env.PUBLIC_BASE_URL ??
    "http://localhost:3000";
  const origin = new URL(baseUrl).origin;
  const runtime = createBetterAuthRuntime({
    databaseUrl,
    secret: process.env.BETTER_AUTH_SECRET ?? "helix_local_better_auth_secret_change_me_32_chars",
    baseUrl,
    trustedOrigins: parseCsv(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? origin),
  });
  try {
    const response = await runtime.auth.handler(
      new Request(`${baseUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
        },
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          rememberMe: true,
        }),
      }),
    );
    if (response.status !== 200) {
      return false;
    }
    const body = (await response.json()) as {
      readonly token?: unknown;
      readonly user?: { readonly email?: unknown };
    };
    if (typeof body.token !== "string" || body.user?.email !== input.email) {
      return false;
    }
    const sessionCookie = sessionCookieFromSetCookie(response.headers.get("set-cookie"));
    if (sessionCookie === null) {
      return false;
    }
    const module = createBetterAuthPlatformModule({
      actorStore: new PostgresBetterAuthActorStore(sql),
      userLinkStore: new PostgresBetterAuthUserLinkStore(sql),
      defaultOrgId: input.orgId,
    });
    const resolver = createBetterAuthSessionActorResolver(module, runtime.sessionVerifier);
    const actor = await resolver({ headers: { cookie: sessionCookie } });
    return actor?.id === input.actorId;
  } finally {
    await runtime.pool.end();
  }
}

function sessionCookieFromSetCookie(setCookie: string | null): string | null {
  if (setCookie === null) {
    return null;
  }
  const firstCookie = setCookie.split(",").find((cookie) => cookie.includes("helix_session="));
  return firstCookie?.trim().split(";")[0] ?? null;
}

function parseCsv(value: string): readonly string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function toUint8Array(body: StorageObject["body"]): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

function createLocalDemoStorageFromEnv(): StorageClient | undefined {
  const endpoint = process.env.RUSTFS_ENDPOINT;
  if (endpoint === undefined || endpoint.length === 0) {
    return undefined;
  }
  return createS3CompatibleStorage({
    endpoint,
    region: process.env.RUSTFS_REGION ?? "us-east-1",
    bucket: process.env.RUSTFS_BUCKET ?? "helix-objects",
    credentials: {
      accessKeyId: process.env.RUSTFS_ACCESS_KEY ?? "helixrustfs",
      secretAccessKey: process.env.RUSTFS_SECRET_KEY ?? "helix_rustfs_dev_secret",
    },
    forcePathStyle: true,
  });
}

function requireAtLeast(failures: string[], label: string, actual: number, expected: number): void {
  if (actual < expected) {
    failures.push(`${label} expected >= ${String(expected)}, got ${String(actual)}`);
  }
}

function requireTrue(failures: string[], label: string, actual: boolean): void {
  if (!actual) {
    failures.push(`${label} was not found`);
  }
}

async function main(): Promise<void> {
  const sql = createSqlClient();
  try {
    const result = await verifyLocalDemo(sql);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
