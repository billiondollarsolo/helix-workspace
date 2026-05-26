import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { hashPassword } from "@better-auth/utils/password";
import type postgres from "postgres";
import type { StorageClient } from "@helix/sdk-types";
import { createSqlClient } from "./client.js";
import {
  DEFAULT_LOCAL_OAUTH_ACTOR_ID,
  DEFAULT_LOCAL_OAUTH_DISPLAY_NAME,
  DEFAULT_LOCAL_OAUTH_EMAIL,
  DEFAULT_LOCAL_OAUTH_ORG_ID,
  seedLocalOAuth,
  type SeedLocalOAuthResult,
} from "./seed-local-oauth.js";
import { createNativeDocumentState } from "../platform/docs/native-state.js";
import { createS3CompatibleStorage } from "../platform/storage/index.js";

export const LOCAL_DEMO_SOURCE = "local-demo";
export const LOCAL_DEMO_VOLUME_SOURCE = "local-demo-volume";
export const DEFAULT_LOCAL_DEMO_VOLUME_MAIL_COUNT = 10_000;
export const LOCAL_DEMO_VOLUME_MAIL_MARKER = "helix-volume-mail-search";
export const DEFAULT_LOCAL_DEMO_PASSWORD = "helix-local-dev-password";
export const DEFAULT_LOCAL_DEMO_ANCHOR_DATE = "2026-05-21";

export interface SeedLocalDemoOptions {
  readonly orgId?: string;
  readonly actorId?: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly password?: string;
  readonly anchorDate?: string | Date | undefined;
  readonly storage?: DemoStorageClient;
  readonly volumeSearch?: SeedLocalDemoVolumeSearchOptions | undefined;
}

export interface SeedLocalDemoVolumeSearchOptions {
  readonly mailMessages?: number | undefined;
}

export interface SeedLocalDemoResult {
  readonly oauth: SeedLocalOAuthResult;
  readonly login: {
    readonly email: string;
    readonly password: string;
  };
  readonly actors: number;
  readonly mailThreads: number;
  readonly driveEntries: number;
  readonly docs: number;
  readonly sheets: number;
  readonly slides: number;
  readonly meetRooms: number;
  readonly calendarEvents: number;
  readonly chatRooms: number;
  readonly chatMessages: number;
  readonly storageObjects: number;
  readonly volumeMailMessages: number;
  readonly anchorDate: string | null;
}

type SeedSql = postgres.Sql | postgres.TransactionSql;
type DemoStorageClient = StorageClient & {
  ensureBucket?(): Promise<void>;
};

interface VolumeMailThreadRow {
  readonly id: string;
  readonly org_id: string;
  readonly kind: "mail";
  readonly subject: string;
  readonly created_by_actor_id: string;
  readonly metadata: postgres.JSONValue;
}

interface VolumeMailMessageRow {
  readonly id: string;
  readonly org_id: string;
  readonly thread_id: string;
  readonly actor_id: string;
  readonly kind: "mail";
  readonly body: string;
  readonly body_format: "plain";
  readonly metadata: postgres.JSONValue;
  readonly sent_at: string;
}

interface VolumeMailThreadStateRow {
  readonly actor_id: string;
  readonly thread_id: string;
  readonly org_id: string;
  readonly labels: readonly string[];
  readonly read_at: string | null;
  readonly starred: boolean;
}

interface VolumeMailPermissionRow {
  readonly org_id: string;
  readonly actor_id: string;
  readonly resource_type: "thread";
  readonly resource_id: string;
  readonly role: "owner";
  readonly granted_by_actor_id: string;
}

const demoIds = {
  colleagueActor: "00000000-0000-4000-8000-000000000201",
  familyActor: "00000000-0000-4000-8000-000000000202",
  driveFolderProjects: "00000000-0000-4000-8000-000000000301",
  driveFileAiServices: "00000000-0000-4000-8000-000000000302",
  driveFileTraining: "00000000-0000-4000-8000-000000000303",
  driveVersionAiServices: "00000000-0000-4000-8000-000000000304",
  driveVersionTraining: "00000000-0000-4000-8000-000000000305",
  docsQuarterly: "00000000-0000-4000-8000-000000000401",
  docsQuarterlyThread: "00000000-0000-4000-8000-000000000402",
  docsRunbook: "00000000-0000-4000-8000-000000000403",
  docsRunbookThread: "00000000-0000-4000-8000-000000000404",
  sheetLaunchMetrics: "00000000-0000-4000-8000-000000000451",
  sheetLaunchMetricsSummaryTab: "00000000-0000-4000-8000-000000000452",
  sheetLaunchMetricsPipelineTab: "00000000-0000-4000-8000-000000000453",
  slidesMvpReadout: "00000000-0000-4000-8000-000000000471",
  slidesMvpReadoutTitle: "00000000-0000-4000-8000-000000000472",
  slidesMvpReadoutStatus: "00000000-0000-4000-8000-000000000473",
  slidesMvpReadoutNext: "00000000-0000-4000-8000-000000000474",
  calendarPrimary: "00000000-0000-4000-8000-000000000501",
  eventOrderMatch: "00000000-0000-4000-8000-000000000502",
  eventOrderMatchThread: "00000000-0000-4000-8000-000000000503",
  eventPlanning: "00000000-0000-4000-8000-000000000504",
  eventPlanningThread: "00000000-0000-4000-8000-000000000505",
  eventMvpWalkthrough: "00000000-0000-4000-8000-000000000506",
  eventMvpWalkthroughThread: "00000000-0000-4000-8000-000000000507",
  meetMvpWalkthrough: "00000000-0000-4000-8000-000000000551",
  meetMvpWalkthroughThread: "00000000-0000-4000-8000-000000000552",
  mailAmazonThread: "00000000-0000-4000-8000-000000000601",
  mailAmazonMessage: "00000000-0000-4000-8000-000000000602",
  mailRenovateThread: "00000000-0000-4000-8000-000000000603",
  mailRenovateMessage: "00000000-0000-4000-8000-000000000604",
  mailPlanningThread: "00000000-0000-4000-8000-000000000605",
  mailPlanningMessage: "00000000-0000-4000-8000-000000000606",
  mailPianoThread: "00000000-0000-4000-8000-000000000607",
  mailPianoMessage: "00000000-0000-4000-8000-000000000608",
  mailAttachmentAmazon: "00000000-0000-4000-8000-000000000609",
  chatRoomLaunch: "00000000-0000-4000-8000-000000000701",
  chatMessageLaunchPlan: "00000000-0000-4000-8000-000000000702",
  chatMessageMailDensity: "00000000-0000-4000-8000-000000000703",
  chatMessageCalendarPreview: "00000000-0000-4000-8000-000000000704",
} as const;

export const LOCAL_DEMO_IDS = demoIds;

const demoThreads = [
  demoIds.docsQuarterlyThread,
  demoIds.docsRunbookThread,
  demoIds.eventOrderMatchThread,
  demoIds.eventPlanningThread,
  demoIds.eventMvpWalkthroughThread,
  demoIds.meetMvpWalkthroughThread,
  demoIds.mailAmazonThread,
  demoIds.mailRenovateThread,
  demoIds.mailPlanningThread,
  demoIds.mailPianoThread,
  demoIds.chatRoomLaunch,
] as const;

const demoObjects = [
  demoIds.driveFileAiServices,
  demoIds.driveFileTraining,
  demoIds.docsQuarterly,
  demoIds.docsRunbook,
  demoIds.mailAttachmentAmazon,
] as const;

const demoFolders = [demoIds.driveFolderProjects] as const;
const demoDocuments = [demoIds.docsQuarterly, demoIds.docsRunbook] as const;
const demoSheets = [demoIds.sheetLaunchMetrics] as const;
const demoSlideDecks = [demoIds.slidesMvpReadout] as const;
const demoMeetRooms = [demoIds.meetMvpWalkthrough] as const;
const demoEvents = [
  demoIds.eventOrderMatch,
  demoIds.eventPlanning,
  demoIds.eventMvpWalkthrough,
] as const;
const demoMessages = [
  demoIds.mailAmazonMessage,
  demoIds.mailRenovateMessage,
  demoIds.mailPlanningMessage,
  demoIds.mailPianoMessage,
  demoIds.chatMessageLaunchPlan,
  demoIds.chatMessageMailDensity,
  demoIds.chatMessageCalendarPreview,
] as const;

const VOLUME_MAIL_BATCH_SIZE = 500;
const baseAnchorDayMs = Date.parse(`${DEFAULT_LOCAL_DEMO_ANCHOR_DATE}T00:00:00.000Z`);

export async function seedLocalDemo(
  sql: postgres.Sql,
  options: SeedLocalDemoOptions = {},
): Promise<SeedLocalDemoResult> {
  const orgId = options.orgId ?? DEFAULT_LOCAL_OAUTH_ORG_ID;
  const actorId = options.actorId ?? DEFAULT_LOCAL_OAUTH_ACTOR_ID;
  const email = options.email ?? DEFAULT_LOCAL_OAUTH_EMAIL;
  const displayName = options.displayName ?? DEFAULT_LOCAL_OAUTH_DISPLAY_NAME;
  const password =
    options.password ?? process.env.HELIX_LOCAL_DEMO_PASSWORD ?? DEFAULT_LOCAL_DEMO_PASSWORD;
  const timeline = createDemoTimeline(options.anchorDate);
  const storage = options.storage ?? createLocalDemoStorageFromEnv();
  const volumeMailMessages = normalizeVolumeMailCount(options.volumeSearch?.mailMessages);
  const oauth = await seedLocalOAuth(sql, { orgId, actorId, email, displayName });
  const passwordHash = await hashPassword(password);
  await storage?.ensureBucket?.();

  await sql.begin(async (tx) => {
    await seedActors(tx, orgId, actorId, email, displayName);
    await clearDemoContent(tx, orgId);
    await seedBetterAuthUser(tx, actorId, email, displayName, passwordHash);
    await seedDrive(tx, orgId, actorId, storage);
    await seedDocs(tx, orgId, actorId, storage);
    await seedSheets(tx, orgId, actorId);
    await seedSlides(tx, orgId, actorId);
    await seedCalendar(tx, orgId, actorId, email, timeline);
    await seedMeet(tx, orgId, actorId, timeline);
    await seedMail(tx, orgId, actorId, email, storage, timeline);
    if (volumeMailMessages > 0) {
      await seedVolumeMail(tx, orgId, actorId, email, volumeMailMessages, timeline);
    }
    await seedChat(tx, orgId, actorId, timeline);
  });

  return {
    oauth,
    login: { email, password },
    actors: 3,
    mailThreads: 4,
    driveEntries: 3,
    docs: 2,
    sheets: 1,
    slides: 1,
    meetRooms: 1,
    calendarEvents: 3,
    chatRooms: 1,
    chatMessages: 3,
    storageObjects: storage === undefined ? 0 : 5,
    volumeMailMessages,
    anchorDate: timeline.anchorDate,
  };
}

async function seedActors(
  sql: SeedSql,
  orgId: string,
  actorId: string,
  email: string,
  displayName: string,
): Promise<void> {
  const actors = [
    {
      id: actorId,
      email,
      displayName,
      scopes: [
        "platform.read",
        "mail.read",
        "mail.write",
        "mail.send",
        "mail.external",
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
        "notifications.read",
        "notifications.write",
        "search.read",
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
      ],
    },
    {
      id: demoIds.colleagueActor,
      email: "maya@helix.local",
      displayName: "Maya Sharma",
      scopes: ["mail.read", "drive.read", "docs.read", "calendar.read", "chat.read"],
    },
    {
      id: demoIds.familyActor,
      email: "erica@helix.local",
      displayName: "Erica Johnson",
      scopes: ["calendar.read"],
    },
  ];

  for (const actor of actors) {
    await sql`
      insert into actors (id, org_id, type, email, display_name, scopes, disabled_at, metadata)
      values (
        ${actor.id},
        ${orgId},
        'user',
        ${actor.email},
        ${actor.displayName},
        ${sql.array(actor.scopes, 1009)},
        null,
        ${json(sql, { source: LOCAL_DEMO_SOURCE })}
      )
      on conflict (id) do update
      set
        org_id = excluded.org_id,
        type = excluded.type,
        email = excluded.email,
        display_name = excluded.display_name,
        scopes = excluded.scopes,
        disabled_at = null,
        metadata = (
          case
            when jsonb_typeof(actors.metadata) = 'object' then actors.metadata
            else '{}'::jsonb
          end
        ) || excluded.metadata,
        updated_at = now()
    `;
  }
}

async function clearDemoContent(sql: SeedSql, orgId: string): Promise<void> {
  await sql`
    delete from permissions
    where org_id = ${orgId}
      and (
        (resource_type = 'thread' and resource_id = any(${sql.array([...demoThreads])}::uuid[]))
        or (resource_type = 'object' and resource_id = any(${sql.array([...demoObjects])}::uuid[]))
        or (resource_type = 'folder' and resource_id = any(${sql.array([...demoFolders])}::uuid[]))
        or (resource_type = 'document' and resource_id = any(${sql.array([...demoDocuments])}::uuid[]))
        or (resource_type = 'sheet' and resource_id = any(${sql.array([...demoSheets])}::uuid[]))
        or (resource_type = 'slide_deck' and resource_id = any(${sql.array([...demoSlideDecks])}::uuid[]))
        or (resource_type = 'meet_room' and resource_id = any(${sql.array([...demoMeetRooms])}::uuid[]))
        or (resource_type = 'calendar' and resource_id = ${demoIds.calendarPrimary})
        or (resource_type = 'event' and resource_id = any(${sql.array([...demoEvents])}::uuid[]))
      )
  `;
  await sql`delete from message_attachments where message_id = any(${sql.array([...demoMessages])}::uuid[])`;
  await sql`delete from mail_thread_state where thread_id = any(${sql.array([...demoThreads])}::uuid[])`;
  await sql`delete from chat_read_receipts where thread_id = ${demoIds.chatRoomLaunch}`;
  await sql`delete from messages where id = any(${sql.array([...demoMessages])}::uuid[])`;
  await sql`delete from docs_comments where document_id = any(${sql.array([...demoDocuments])}::uuid[])`;
  await sql`delete from docs_updates where document_id = any(${sql.array([...demoDocuments])}::uuid[])`;
  await sql`delete from docs_documents where id = any(${sql.array([...demoDocuments])}::uuid[])`;
  await sql`delete from sheet_cells where sheet_tab_id in (select id from sheet_tabs where sheet_id = any(${sql.array([...demoSheets])}::uuid[]))`;
  await sql`delete from sheet_tabs where sheet_id = any(${sql.array([...demoSheets])}::uuid[])`;
  await sql`delete from sheets where id = any(${sql.array([...demoSheets])}::uuid[])`;
  await sql`delete from slides where deck_id = any(${sql.array([...demoSlideDecks])}::uuid[])`;
  await sql`delete from slide_decks where id = any(${sql.array([...demoSlideDecks])}::uuid[])`;
  await sql`delete from cal_attendees where event_id = any(${sql.array([...demoEvents])}::uuid[])`;
  await sql`delete from cal_events where id = any(${sql.array([...demoEvents])}::uuid[])`;
  await sql`delete from cal_calendars where id = ${demoIds.calendarPrimary}`;
  await sql`delete from meet_rooms where id = any(${sql.array([...demoMeetRooms])}::uuid[])`;
  await sql`delete from drive_versions where object_id = any(${sql.array([...demoObjects])}::uuid[])`;
  await sql`delete from objects where id = any(${sql.array([...demoObjects, ...demoSheets, ...demoSlideDecks])}::uuid[])`;
  await sql`delete from drive_folders where id = any(${sql.array([...demoFolders])}::uuid[])`;
  await sql`delete from threads where id = any(${sql.array([...demoThreads])}::uuid[])`;
  await clearVolumeDemoContent(sql, orgId);
  await clearSyntheticSmokeContent(sql, orgId);
}

async function clearSyntheticSmokeContent(sql: SeedSql, orgId: string): Promise<void> {
  await sql`
    delete from permissions
    where org_id = ${orgId}
      and (
        (resource_type = 'thread' and resource_id in (
          select id from threads
          where org_id = ${orgId}
            and (
              subject ilike 'k6 %'
              or subject ilike '% k6 %'
              or subject ilike '%helix-live%'
              or subject ilike 'MVP workflow smoke%'
              or metadata->>'source' = 'k6'
            )
        ))
        or (resource_type = 'document' and resource_id in (
          select id from docs_documents
          where org_id = ${orgId}
            and (
              title ilike 'k6 %'
              or metadata->>'source' = 'k6'
              or metadata->>'marker' ilike '%k6%'
            )
        ))
        or (resource_type = 'meet_room' and resource_id in (
          select r.id
          from meet_rooms r
          join threads t on t.id = r.thread_id
          where r.org_id = ${orgId}
            and (
              t.subject ilike 'k6 %'
              or t.subject ilike '% k6 %'
              or t.metadata->>'source' = 'k6'
            )
        ))
        or (resource_type = 'object' and resource_id in (
          select id from objects
          where org_id = ${orgId}
            and (
              metadata->>'source' = 'k6'
              or metadata->>'marker' ilike '%k6%'
              or metadata->>'name' ilike 'k6 %'
              or metadata->>'title' ilike 'k6 %'
              or storage_key ilike '%k6%'
            )
        ))
      )
  `;
  await sql`
    delete from message_attachments
    where message_id in (
      select m.id
      from messages m
      join threads t on t.id = m.thread_id
      where m.org_id = ${orgId}
        and (
          t.subject ilike 'k6 %'
          or t.subject ilike '% k6 %'
          or t.subject ilike '%helix-live%'
          or t.subject ilike 'MVP workflow smoke%'
          or t.metadata->>'source' = 'k6'
          or m.metadata->>'source' = 'k6'
        )
    )
      or object_id in (
        select id from objects
        where org_id = ${orgId}
          and (
            metadata->>'source' = 'k6'
            or metadata->>'marker' ilike '%k6%'
            or metadata->>'name' ilike 'k6 %'
            or metadata->>'title' ilike 'k6 %'
            or storage_key ilike '%k6%'
          )
      )
  `;
  await sql`
    delete from mail_thread_state
    where org_id = ${orgId}
      and thread_id in (
        select id from threads
        where org_id = ${orgId}
          and (
            subject ilike 'k6 %'
            or subject ilike '% k6 %'
            or subject ilike '%helix-live%'
            or subject ilike 'MVP workflow smoke%'
            or metadata->>'source' = 'k6'
          )
      )
  `;
  await sql`
    delete from pending_actions
    where org_id = ${orgId}
      and tool_id = 'mail.send'
      and input->>'subject' ilike 'MVP workflow smoke%'
  `;
  await sql`
    delete from docs_comments
    where org_id = ${orgId}
      and document_id in (
        select id from docs_documents
        where org_id = ${orgId}
          and (
            title ilike 'k6 %'
            or metadata->>'source' = 'k6'
            or metadata->>'marker' ilike '%k6%'
          )
      )
  `;
  await sql`
    delete from docs_updates
    where org_id = ${orgId}
      and document_id in (
        select id from docs_documents
        where org_id = ${orgId}
          and (
            title ilike 'k6 %'
            or metadata->>'source' = 'k6'
            or metadata->>'marker' ilike '%k6%'
          )
      )
  `;
  await sql`
    delete from docs_documents
    where org_id = ${orgId}
      and (
        title ilike 'k6 %'
        or metadata->>'source' = 'k6'
        or metadata->>'marker' ilike '%k6%'
      )
  `;
  await sql`
    delete from drive_versions
    where org_id = ${orgId}
      and object_id in (
        select id from objects
        where org_id = ${orgId}
          and (
            metadata->>'source' = 'k6'
            or metadata->>'marker' ilike '%k6%'
            or metadata->>'name' ilike 'k6 %'
            or metadata->>'title' ilike 'k6 %'
            or storage_key ilike '%k6%'
          )
      )
  `;
  await sql`
    delete from objects
    where org_id = ${orgId}
      and (
        metadata->>'source' = 'k6'
        or metadata->>'marker' ilike '%k6%'
        or metadata->>'name' ilike 'k6 %'
        or metadata->>'title' ilike 'k6 %'
        or storage_key ilike '%k6%'
      )
  `;
  await sql`
    delete from meet_rooms
    where org_id = ${orgId}
      and (
        metadata->>'source' = 'k6'
        or thread_id in (
          select id from threads
          where org_id = ${orgId}
            and (
              subject ilike 'k6 %'
              or subject ilike '% k6 %'
              or metadata->>'source' = 'k6'
            )
        )
      )
  `;
  await sql`
    with doomed_messages as (
      select m.id
      from messages m
      join threads t on t.id = m.thread_id
      where m.org_id = ${orgId}
        and (
          t.subject ilike 'k6 %'
          or t.subject ilike '% k6 %'
          or t.subject ilike '%helix-live%'
          or t.subject ilike 'MVP workflow smoke%'
          or t.metadata->>'source' = 'k6'
          or m.metadata->>'source' = 'k6'
        )
    ),
    deleted_outbound_messages as (
      delete from mail_outbound_messages
      where org_id = ${orgId}
        and message_id in (select id from doomed_messages)
      returning outbox_id
    )
    delete from outbox
    where id in (
      select outbox_id
      from deleted_outbound_messages
      where outbox_id is not null
    )
  `;
  await sql`
    delete from messages
    where org_id = ${orgId}
      and (
        metadata->>'source' = 'k6'
        or thread_id in (
          select id from threads
          where org_id = ${orgId}
            and (
              subject ilike 'k6 %'
              or subject ilike '% k6 %'
              or subject ilike '%helix-live%'
              or subject ilike 'MVP workflow smoke%'
              or metadata->>'source' = 'k6'
            )
        )
      )
  `;
  await sql`
    delete from threads
    where org_id = ${orgId}
      and (
        subject ilike 'k6 %'
        or subject ilike '% k6 %'
        or subject ilike '%helix-live%'
        or subject ilike 'MVP workflow smoke%'
        or metadata->>'source' = 'k6'
      )
  `;
}

async function clearVolumeDemoContent(sql: SeedSql, orgId: string): Promise<void> {
  await sql`
    delete from permissions
    where org_id = ${orgId}
      and resource_type = 'thread'
      and resource_id in (
        select id from threads
        where org_id = ${orgId}
          and metadata->>'source' = ${LOCAL_DEMO_VOLUME_SOURCE}
      )
  `;
  await sql`
    delete from mail_thread_state
    where org_id = ${orgId}
      and thread_id in (
        select id from threads
        where org_id = ${orgId}
          and metadata->>'source' = ${LOCAL_DEMO_VOLUME_SOURCE}
      )
  `;
  await sql`
    delete from messages
    where org_id = ${orgId}
      and metadata->>'source' = ${LOCAL_DEMO_VOLUME_SOURCE}
  `;
  await sql`
    delete from threads
    where org_id = ${orgId}
      and metadata->>'source' = ${LOCAL_DEMO_VOLUME_SOURCE}
  `;
}

async function seedBetterAuthUser(
  sql: SeedSql,
  actorId: string,
  email: string,
  displayName: string,
  passwordHash: string,
): Promise<void> {
  const defaultUserId = `demo-${actorId}`;
  const rows = await sql<{ readonly id: string }[]>`
    insert into "user" (id, name, email, "emailVerified", actor_id, "createdAt", "updatedAt")
    values (${defaultUserId}, ${displayName}, ${email}, true, ${actorId}, now(), now())
    on conflict (lower(email)) do update
    set
      name = excluded.name,
      email = excluded.email,
      "emailVerified" = true,
      actor_id = excluded.actor_id,
      "updatedAt" = now()
    returning id
  `;
  const userId = rows[0]?.id ?? defaultUserId;
  await sql`
    delete from actors
    where lower(email) = ${email.toLowerCase()}
      and id <> ${actorId}
      and metadata -> 'betterAuth' ->> 'userId' = ${userId}
  `;
  await sql`
    update actors
    set
      metadata = (
        case
          when jsonb_typeof(metadata) = 'object' then metadata
          else '{}'::jsonb
        end
      ) || ${json(sql, { betterAuth: { userId, emailVerified: true } })},
      updated_at = now()
    where id = ${actorId}
  `;
  await sql`
    insert into account (
      id,
      "userId",
      "accountId",
      "providerId",
      password,
      "createdAt",
      "updatedAt"
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
      password = excluded.password,
      "updatedAt" = now()
  `;
}

async function seedDrive(
  sql: SeedSql,
  orgId: string,
  actorId: string,
  storage: DemoStorageClient | undefined,
): Promise<void> {
  await sql`
    insert into drive_folders (id, org_id, name, parent_folder_id, owner_actor_id, created_by_actor_id, metadata)
    values (
      ${demoIds.driveFolderProjects},
      ${orgId},
      'Projects',
      null,
      ${actorId},
      ${actorId},
      ${json(sql, { source: LOCAL_DEMO_SOURCE, color: "blue" })}
    )
  `;
  await grant(sql, orgId, actorId, "folder", demoIds.driveFolderProjects, "owner", actorId);

  await seedDriveFile(sql, {
    orgId,
    actorId,
    objectId: demoIds.driveFileAiServices,
    versionId: demoIds.driveVersionAiServices,
    name: "AI Services and Keys",
    folderId: null,
    mimeType: "text/markdown",
    body: "# AI Services and Keys\n\nLocal Ollama and OpenAI-compatible endpoints for testing Helix assistant routing.\n",
    storage,
  });
  await seedDriveFile(sql, {
    orgId,
    actorId,
    objectId: demoIds.driveFileTraining,
    versionId: demoIds.driveVersionTraining,
    name: "Training Course Links",
    folderId: demoIds.driveFolderProjects,
    mimeType: "text/plain",
    body: "Security review: May 20\nCalendar rollout: May 21\nMail filtering regression checklist\n",
    storage,
  });
}

async function seedDriveFile(
  sql: SeedSql,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly versionId: string;
    readonly name: string;
    readonly folderId: string | null;
    readonly mimeType: string;
    readonly body: string;
    readonly storage: DemoStorageClient | undefined;
  },
): Promise<void> {
  const sha256 = sha(input.body);
  const storageKey = `demo/${input.orgId}/${input.objectId}/${input.name}`;
  await putDemoStorageObject(input.storage, {
    key: storageKey,
    body: input.body,
    contentType: input.mimeType,
    metadata: { source: LOCAL_DEMO_SOURCE, objectId: input.objectId, sha256 },
  });
  await sql`
    insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
    values (
      ${input.objectId},
      ${input.orgId},
      ${input.actorId},
      'file',
      ${storageKey},
      ${input.mimeType},
      ${Buffer.byteLength(input.body, "utf8")},
      ${sha256},
      ${json(sql, {
        source: LOCAL_DEMO_SOURCE,
        name: input.name,
        folderId: input.folderId,
        status: "ready",
        seededContent: input.body,
      })}
    )
  `;
  await sql`
    insert into drive_versions (
      id, org_id, object_id, version_number, storage_key, mime_type, byte_size, sha256, metadata, created_by_actor_id
    )
    values (
      ${input.versionId},
      ${input.orgId},
      ${input.objectId},
      1,
      ${storageKey},
      ${input.mimeType},
      ${Buffer.byteLength(input.body, "utf8")},
      ${sha256},
      ${json(sql, { source: LOCAL_DEMO_SOURCE })},
      ${input.actorId}
    )
  `;
  await grant(sql, input.orgId, input.actorId, "object", input.objectId, "owner", input.actorId);
}

async function seedDocs(
  sql: SeedSql,
  orgId: string,
  actorId: string,
  storage: DemoStorageClient | undefined,
): Promise<void> {
  await seedDoc(sql, {
    orgId,
    actorId,
    documentId: demoIds.docsQuarterly,
    threadId: demoIds.docsQuarterlyThread,
    title: "Quarterly Planning Notes",
    markdown:
      "# Quarterly Planning Notes\n\n- Tighten mail list density.\n- Validate Better Auth session flows.\n- Finish Drive/docs/calendar seeded data.\n",
    tags: ["planning", "product"],
    storage,
  });
  await seedDoc(sql, {
    orgId,
    actorId,
    documentId: demoIds.docsRunbook,
    threadId: demoIds.docsRunbookThread,
    title: "Local Testing Runbook",
    markdown:
      "# Local Testing Runbook\n\nUse the seeded OAuth client, open Mail, inspect Drive, and create a calendar RSVP.\n",
    tags: ["runbook", "local"],
    storage,
  });
}

async function seedDoc(
  sql: SeedSql,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly documentId: string;
    readonly threadId: string;
    readonly title: string;
    readonly markdown: string;
    readonly tags: readonly string[];
    readonly storage: DemoStorageClient | undefined;
  },
): Promise<void> {
  const storageKey = `docs/${input.orgId}/${input.documentId}`;
  const nativeState = createNativeDocumentState(input.markdown);
  await putDemoStorageObject(input.storage, {
    key: storageKey,
    body: nativeState.state,
    contentType: "application/vnd.helix.document",
    metadata: {
      source: LOCAL_DEMO_SOURCE,
      objectId: input.documentId,
      documentId: input.documentId,
      sha256: shaBuffer(nativeState.state),
    },
  });
  await sql`
    insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
    values (${input.threadId}, ${input.orgId}, 'doc', ${input.title}, ${input.actorId}, ${json(sql, { source: LOCAL_DEMO_SOURCE })})
  `;
  await sql`
    insert into docs_documents (
      id, org_id, title, thread_id, owner_actor_id, created_by_actor_id, ydoc_state, ydoc_state_vector, update_seq, metadata
    )
    values (
      ${input.documentId},
      ${input.orgId},
      ${input.title},
      ${input.threadId},
      ${input.actorId},
      ${input.actorId},
      ${nativeState.state},
      ${nativeState.stateVector},
      0,
      ${json(sql, {
        source: LOCAL_DEMO_SOURCE,
        editorEngine: "helix-native-document",
        formatVersion: 1,
        plainText: input.markdown,
        tags: input.tags,
      })}
    )
  `;
  await sql`
    insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
    values (
      ${input.documentId},
      ${input.orgId},
      ${input.actorId},
      'file',
      ${storageKey},
      'application/vnd.helix.document',
      ${nativeState.state.byteLength},
      ${shaBuffer(nativeState.state)},
      ${json(sql, {
        source: LOCAL_DEMO_SOURCE,
        app: "docs",
        docId: input.documentId,
        name: `${input.title}.helixdoc`,
        title: input.title,
        folderId: demoIds.driveFolderProjects,
        editorEngine: "helix-native-document",
        formatVersion: 1,
      })}
    )
  `;
  await grant(sql, input.orgId, input.actorId, "thread", input.threadId, "owner", input.actorId);
  await grant(
    sql,
    input.orgId,
    input.actorId,
    "document",
    input.documentId,
    "owner",
    input.actorId,
  );
  await grant(sql, input.orgId, input.actorId, "object", input.documentId, "owner", input.actorId);
}

async function seedSheets(sql: SeedSql, orgId: string, actorId: string): Promise<void> {
  await sql`
    insert into sheets (id, org_id, owner_actor_id, created_by_actor_id, title, metadata)
    values (
      ${demoIds.sheetLaunchMetrics},
      ${orgId},
      ${actorId},
      ${actorId},
      'Launch Metrics Tracker',
      ${json(sql, { source: LOCAL_DEMO_SOURCE, app: "sheets" })}
    )
  `;
  await sql`
    insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
    values (
      ${demoIds.sheetLaunchMetrics},
      ${orgId},
      ${actorId},
      'file',
      ${`sheets/${orgId}/${demoIds.sheetLaunchMetrics}`},
      'application/vnd.helix.spreadsheet',
      0,
      null,
      ${json(sql, {
        source: LOCAL_DEMO_SOURCE,
        app: "sheets",
        sheetId: demoIds.sheetLaunchMetrics,
        name: "Launch Metrics Tracker",
        title: "Launch Metrics Tracker",
        folderId: null,
      })}
    )
  `;

  const tabs = [
    {
      id: demoIds.sheetLaunchMetricsSummaryTab,
      name: "Summary",
      rows: [
        ["Metric", "Target", "Current", "Status"],
        ["Mail searchable threads", "200", "205", "On track"],
        ["Drive seeded files", "3", "3", "On track"],
        ["Docs ready for review", "2", "2", "On track"],
        ["Open MVP blockers", "0", "3", "Watch"],
      ],
    },
    {
      id: demoIds.sheetLaunchMetricsPipelineTab,
      name: "Pipeline",
      rows: [
        ["Surface", "Owner", "MVP workflow", "Next check"],
        ["Mail", "Local Helix Admin", "Search, open, compose", "Today"],
        ["Drive", "Maya Sharma", "Upload, preview, share", "Today"],
        ["Calendar", "Local Helix Admin", "Create event, respond", "This week"],
        ["Assistant", "Local Helix Admin", "Ask, confirm action", "This week"],
      ],
    },
  ] as const;

  for (const [tabIndex, tab] of tabs.entries()) {
    await sql`
      insert into sheet_tabs (id, org_id, sheet_id, name, position, metadata)
      values (
        ${tab.id},
        ${orgId},
        ${demoIds.sheetLaunchMetrics},
        ${tab.name},
        ${tabIndex},
        ${json(sql, { source: LOCAL_DEMO_SOURCE })}
      )
    `;
    for (const [rowIndex, row] of tab.rows.entries()) {
      for (const [colIndex, value] of row.entries()) {
        await sql`
          insert into sheet_cells (id, org_id, sheet_tab_id, row, col, value, format)
          values (
            ${demoCellId(tabIndex, rowIndex, colIndex)},
            ${orgId},
            ${tab.id},
            ${rowIndex},
            ${colIndex},
            ${value},
            ${json(sql, rowIndex === 0 ? { bold: true } : {})}
          )
        `;
      }
    }
  }

  await grant(sql, orgId, actorId, "sheet", demoIds.sheetLaunchMetrics, "owner", actorId);
}

async function seedSlides(sql: SeedSql, orgId: string, actorId: string): Promise<void> {
  await sql`
    insert into slide_decks (id, org_id, title, owner_actor_id, created_by_actor_id, metadata)
    values (
      ${demoIds.slidesMvpReadout},
      ${orgId},
      'MVP Readiness Readout',
      ${actorId},
      ${actorId},
      ${json(sql, { source: LOCAL_DEMO_SOURCE, app: "slides" })}
    )
  `;
  await sql`
    insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
    values (
      ${demoIds.slidesMvpReadout},
      ${orgId},
      ${actorId},
      'file',
      ${`slides/${orgId}/${demoIds.slidesMvpReadout}`},
      'application/vnd.helix.presentation',
      0,
      null,
      ${json(sql, {
        source: LOCAL_DEMO_SOURCE,
        app: "slides",
        deckId: demoIds.slidesMvpReadout,
        name: "MVP Readiness Readout",
        title: "MVP Readiness Readout",
        slideCount: 3,
        folderId: null,
      })}
    )
  `;

  const slides = [
    {
      id: demoIds.slidesMvpReadoutTitle,
      layout: "title",
      content: {
        layout: "title",
        eyebrow: "Helix Local Demo",
        title: "MVP Readiness Readout",
        subtitle: "A seeded deck for validating native Slides locally.",
      },
      notes: "Use this deck to verify list, open, edit, present, and export flows.",
    },
    {
      id: demoIds.slidesMvpReadoutStatus,
      layout: "stats",
      content: {
        layout: "stats",
        title: "What is live in the demo",
        subtitle: "Seeded data across the core workspace surfaces",
        stats: [
          { value: "205", label: "mail hits", note: "search-indexed" },
          { value: "3", label: "Drive entries", note: "plus docs, sheets, slides" },
          { value: "3", label: "calendar events", note: "includes current-week check-in" },
        ],
      },
      notes: "Keep this slide aligned with local demo verification counts.",
    },
    {
      id: demoIds.slidesMvpReadoutNext,
      layout: "bullets",
      content: {
        layout: "bullets",
        title: "Next feature checks",
        items: [
          "Open and edit the seeded spreadsheet.",
          "Present this deck and test export readiness.",
          "Create a calendar event from the current week view.",
          "Ask Helix AI to summarize the launch room.",
        ],
      },
      notes: "These are the next manual MVP checks after shell route verification.",
    },
  ] as const;

  for (const [index, slide] of slides.entries()) {
    await sql`
      insert into slides (id, org_id, deck_id, position, layout, content, speaker_notes)
      values (
        ${slide.id},
        ${orgId},
        ${demoIds.slidesMvpReadout},
        ${index},
        ${slide.layout},
        ${json(sql, slide.content)},
        ${slide.notes}
      )
    `;
  }

  await grant(sql, orgId, actorId, "slide_deck", demoIds.slidesMvpReadout, "owner", actorId);
}

async function seedCalendar(
  sql: SeedSql,
  orgId: string,
  actorId: string,
  actorEmail: string,
  timeline: DemoTimeline,
): Promise<void> {
  await sql`
    insert into cal_calendars (id, org_id, owner_actor_id, name, color, timezone, description, metadata)
    values (
      ${demoIds.calendarPrimary},
      ${orgId},
      ${actorId},
      'Primary',
      '#1a73e8',
      'America/New_York',
      'Seeded local demo calendar',
      ${json(sql, { source: LOCAL_DEMO_SOURCE })}
    )
  `;
  await grant(sql, orgId, actorId, "calendar", demoIds.calendarPrimary, "owner", actorId);
  await seedCalendarEvent(sql, {
    orgId,
    actorId,
    actorEmail,
    threadId: demoIds.eventOrderMatchThread,
    eventId: demoIds.eventOrderMatch,
    uid: "demo-order-match@helix.local",
    title: "Order match ball",
    description: "Bring printed order confirmation and payment receipt.",
    location: "Indoor Court 2",
    startsAt: timeline.at("2026-05-20T14:00:00.000Z"),
    endsAt: timeline.at("2026-05-20T15:00:00.000Z"),
    attendees: [
      { actorId: demoIds.colleagueActor, email: "maya@helix.local", displayName: "Maya Sharma" },
    ],
  });
  await seedCalendarEvent(sql, {
    orgId,
    actorId,
    actorEmail,
    threadId: demoIds.eventPlanningThread,
    eventId: demoIds.eventPlanning,
    uid: "demo-planning@helix.local",
    title: "Product planning review",
    description: "Review seeded mail, Drive, docs, and calendar flows.",
    location: "Helix Meet",
    startsAt: timeline.at("2026-05-21T17:00:00.000Z"),
    endsAt: timeline.at("2026-05-21T17:45:00.000Z"),
    attendees: [
      { actorId: demoIds.colleagueActor, email: "maya@helix.local", displayName: "Maya Sharma" },
      { actorId: demoIds.familyActor, email: "erica@helix.local", displayName: "Erica Johnson" },
    ],
  });
  await seedCalendarEvent(sql, {
    orgId,
    actorId,
    actorEmail,
    threadId: demoIds.eventMvpWalkthroughThread,
    eventId: demoIds.eventMvpWalkthrough,
    uid: "demo-mvp-walkthrough@helix.local",
    title: "MVP surface walkthrough",
    description: "Open Mail, Drive, Docs, Sheets, Slides, Calendar, Chat, Meet, and Assistant.",
    location: "Helix Meet",
    startsAt: timeline.at("2026-05-26T14:00:00.000Z"),
    endsAt: timeline.at("2026-05-26T15:00:00.000Z"),
    attendees: [
      { actorId: demoIds.colleagueActor, email: "maya@helix.local", displayName: "Maya Sharma" },
    ],
  });
}

async function seedCalendarEvent(
  sql: SeedSql,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly actorEmail: string;
    readonly threadId: string;
    readonly eventId: string;
    readonly uid: string;
    readonly title: string;
    readonly description: string;
    readonly location: string;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly attendees: readonly {
      readonly actorId: string;
      readonly email: string;
      readonly displayName: string;
    }[];
  },
): Promise<void> {
  await sql`
    insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
    values (${input.threadId}, ${input.orgId}, 'calendar', ${input.title}, ${input.actorId}, ${json(sql, { source: LOCAL_DEMO_SOURCE })})
  `;
  await sql`
    insert into cal_events (
      id, org_id, calendar_id, thread_id, uid, title, description, location, starts_at, ends_at,
      timezone, all_day, status, organizer_actor_id, organizer_email, metadata
    )
    values (
      ${input.eventId},
      ${input.orgId},
      ${demoIds.calendarPrimary},
      ${input.threadId},
      ${input.uid},
      ${input.title},
      ${input.description},
      ${input.location},
      ${input.startsAt},
      ${input.endsAt},
      'America/New_York',
      false,
      'confirmed',
      ${input.actorId},
      ${input.actorEmail},
      ${json(sql, { source: LOCAL_DEMO_SOURCE, visibility: "default", classification: "standard" })}
    )
  `;
  await sql`
    insert into cal_attendees (
      org_id, event_id, actor_id, email, display_name, role, response_status, is_organizer, metadata
    )
    values (
      ${input.orgId},
      ${input.eventId},
      ${input.actorId},
      ${input.actorEmail},
      'Local Helix Admin',
      'required',
      'accepted',
      true,
      ${json(sql, { source: LOCAL_DEMO_SOURCE })}
    )
  `;
  for (const attendee of input.attendees) {
    await sql`
      insert into cal_attendees (
        org_id, event_id, actor_id, email, display_name, role, response_status, is_organizer, metadata
      )
      values (
        ${input.orgId},
        ${input.eventId},
        ${attendee.actorId},
        ${attendee.email},
        ${attendee.displayName},
        'required',
        'needs_action',
        false,
        ${json(sql, { source: LOCAL_DEMO_SOURCE })}
      )
    `;
  }
  await grant(sql, input.orgId, input.actorId, "thread", input.threadId, "owner", input.actorId);
  await grant(sql, input.orgId, input.actorId, "event", input.eventId, "owner", input.actorId);
}

async function seedMeet(
  sql: SeedSql,
  orgId: string,
  actorId: string,
  timeline: DemoTimeline,
): Promise<void> {
  const scheduledStartAt = timeline.at("2026-05-26T14:00:00.000Z");
  const scheduledEndAt = timeline.at("2026-05-26T15:00:00.000Z");
  await sql`
    insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
    values (
      ${demoIds.meetMvpWalkthroughThread},
      ${orgId},
      'call',
      'MVP surface walkthrough',
      ${actorId},
      ${json(sql, {
        source: LOCAL_DEMO_SOURCE,
        jitsiDomain: "meet.localhost",
        roomName: "mvp-surface-walkthrough",
      })}
    )
  `;
  await sql`
    insert into meet_rooms (
      id, org_id, thread_id, room_name, subject, jitsi_domain, created_by_actor_id,
      started_at, scheduled_start_at, scheduled_end_at, status, metadata
    )
    values (
      ${demoIds.meetMvpWalkthrough},
      ${orgId},
      ${demoIds.meetMvpWalkthroughThread},
      'mvp-surface-walkthrough',
      'MVP surface walkthrough',
      'meet.localhost',
      ${actorId},
      ${scheduledStartAt},
      ${scheduledStartAt},
      ${scheduledEndAt},
      'active',
      ${json(sql, {
        source: LOCAL_DEMO_SOURCE,
        agenda: ["Mail", "Drive", "Docs", "Sheets", "Slides", "Calendar", "Chat", "Assistant"],
      })}
    )
  `;
  await grant(sql, orgId, actorId, "thread", demoIds.meetMvpWalkthroughThread, "owner", actorId);
  await grant(
    sql,
    orgId,
    demoIds.colleagueActor,
    "thread",
    demoIds.meetMvpWalkthroughThread,
    "member",
    actorId,
  );
  await grant(sql, orgId, actorId, "meet_room", demoIds.meetMvpWalkthrough, "owner", actorId);
  await grant(
    sql,
    orgId,
    demoIds.colleagueActor,
    "meet_room",
    demoIds.meetMvpWalkthrough,
    "member",
    actorId,
  );
}

async function seedMail(
  sql: SeedSql,
  orgId: string,
  actorId: string,
  actorEmail: string,
  storage: DemoStorageClient | undefined,
  timeline: DemoTimeline,
): Promise<void> {
  const messages = [
    {
      threadId: demoIds.mailAmazonThread,
      messageId: demoIds.mailAmazonMessage,
      subject: "3 items from Amazon arriving tomorrow",
      from: { address: "shipment-tracking@amazon.example", name: "Amazon" },
      body: "Your order with three household items is expected tomorrow. Track package delivery and review order details in Drive.",
      sentAt: timeline.at("2026-05-20T10:20:00.000Z"),
      labels: ["inbox", "purchases"],
      starred: false,
      readAt: null,
      attachment: true,
    },
    {
      threadId: demoIds.mailRenovateThread,
      messageId: demoIds.mailRenovateMessage,
      subject: "[AlphaBravoCompany/remotedialer] Run failed: Renovate - main",
      from: { address: "mjtechguy@example.com", name: "mjtechguy" },
      body: "Renovate workflow run failed on main. Dependency update requires manual review before the next deploy.",
      sentAt: timeline.at("2026-05-20T07:46:00.000Z"),
      labels: ["inbox", "updates"],
      starred: true,
      readAt: null,
      attachment: false,
    },
    {
      threadId: demoIds.mailPlanningThread,
      messageId: demoIds.mailPlanningMessage,
      subject: "Request to revisit compensation for expanded responsibilities",
      from: { address: "maya@helix.local", name: "Maya Sharma" },
      body: "I wanted to follow up regarding current role scope, platform ownership, and the added backend responsibilities from the Helix rollout.",
      sentAt: timeline.at("2026-05-19T23:32:00.000Z"),
      labels: ["inbox", "important"],
      starred: false,
      readAt: timeline.at("2026-05-20T00:00:00.000Z"),
      attachment: false,
    },
    {
      threadId: demoIds.mailPianoThread,
      messageId: demoIds.mailPianoMessage,
      subject: "4:40 piano lesson reminder",
      from: { address: "erica@helix.local", name: "Erica Johnson" },
      body: "Piano lesson is still at 4:40 today. Please bring the blue folder and the recital note.",
      sentAt: timeline.at("2026-05-19T20:20:00.000Z"),
      labels: ["inbox", "family"],
      starred: false,
      readAt: null,
      attachment: false,
    },
  ] as const;

  for (const message of messages) {
    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (
        ${message.threadId},
        ${orgId},
        'mail',
        ${message.subject},
        ${actorId},
        ${json(sql, { source: LOCAL_DEMO_SOURCE, messageId: `<${message.messageId}@demo.helix.local>` })}
      )
    `;
    await sql`
      insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
      values (
        ${message.messageId},
        ${orgId},
        ${message.threadId},
        ${actorId},
        'mail',
        ${message.body},
        'plain',
        ${json(sql, {
          source: LOCAL_DEMO_SOURCE,
          direction: "inbound",
          from: message.from,
          to: [{ address: actorEmail, name: "Local Helix Admin" }],
          cc: [],
          bcc: [],
          subject: message.subject,
          messageId: `<${message.messageId}@demo.helix.local>`,
          inReplyTo: null,
          references: [],
        })},
        ${message.sentAt}
      )
    `;
    await sql`
      insert into mail_thread_state (
        actor_id, thread_id, org_id, labels, archived_at, deleted_at, snoozed_until, read_at, starred, updated_at
      )
      values (
        ${actorId},
        ${message.threadId},
        ${orgId},
        ${sql.array([...message.labels])},
        null,
        null,
        null,
        ${message.readAt},
        ${message.starred},
        now()
      )
    `;
    await grant(sql, orgId, actorId, "thread", message.threadId, "owner", actorId);
  }

  const attachmentBody = "Order summary for three household items. Expected delivery: tomorrow.";
  const attachmentStorageKey = `mail/${demoIds.mailAmazonMessage}/order-summary.txt`;
  await putDemoStorageObject(storage, {
    key: attachmentStorageKey,
    body: attachmentBody,
    contentType: "text/plain",
    metadata: {
      source: LOCAL_DEMO_SOURCE,
      objectId: demoIds.mailAttachmentAmazon,
      sha256: sha(attachmentBody),
    },
  });
  await sql`
    insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
    values (
      ${demoIds.mailAttachmentAmazon},
      ${orgId},
      ${actorId},
      'mail_attachment',
      ${attachmentStorageKey},
      'text/plain',
      ${Buffer.byteLength(attachmentBody, "utf8")},
      ${sha(attachmentBody)},
      ${json(sql, { source: LOCAL_DEMO_SOURCE, filename: "order-summary.txt", contentId: null })}
    )
  `;
  await sql`
    insert into message_attachments (message_id, object_id, disposition)
    values (${demoIds.mailAmazonMessage}, ${demoIds.mailAttachmentAmazon}, 'attachment')
  `;
  await grant(sql, orgId, actorId, "object", demoIds.mailAttachmentAmazon, "owner", actorId);
}

async function seedVolumeMail(
  sql: SeedSql,
  orgId: string,
  actorId: string,
  actorEmail: string,
  count: number,
  timeline: DemoTimeline,
): Promise<void> {
  for (let start = 1; start <= count; start += VOLUME_MAIL_BATCH_SIZE) {
    const end = Math.min(start + VOLUME_MAIL_BATCH_SIZE - 1, count);
    const threads: VolumeMailThreadRow[] = [];
    const messages: VolumeMailMessageRow[] = [];
    const states: VolumeMailThreadStateRow[] = [];
    const permissions: VolumeMailPermissionRow[] = [];

    for (let index = start; index <= end; index += 1) {
      const threadId = volumeUuid("4100", index);
      const messageId = volumeUuid("4200", index);
      const sequence = index.toString().padStart(5, "0");
      const subject = `${LOCAL_DEMO_VOLUME_MAIL_MARKER} message ${sequence}`;
      const body = [
        `${LOCAL_DEMO_VOLUME_MAIL_MARKER} body ${sequence}.`,
        "Synthetic 10k-mail corpus for global search and mail-list performance validation.",
        index % 2 === 0 ? "Category: invoices." : "Category: operations.",
        index % 5 === 0
          ? "Includes quarterly planning keyword."
          : "Includes routine status keyword.",
      ].join(" ");

      threads.push({
        id: threadId,
        org_id: orgId,
        kind: "mail",
        subject,
        created_by_actor_id: actorId,
        metadata: {
          source: LOCAL_DEMO_VOLUME_SOURCE,
          sequence: index,
          marker: LOCAL_DEMO_VOLUME_MAIL_MARKER,
          messageId: `<${messageId}@volume.demo.helix.local>`,
        },
      });
      messages.push({
        id: messageId,
        org_id: orgId,
        thread_id: threadId,
        actor_id: actorId,
        kind: "mail",
        body,
        body_format: "plain",
        metadata: {
          source: LOCAL_DEMO_VOLUME_SOURCE,
          direction: "inbound",
          from: { address: `volume-${sequence}@example.test`, name: `Volume Sender ${sequence}` },
          to: [{ address: actorEmail, name: "Local Helix Admin" }],
          cc: [],
          bcc: [],
          subject,
          messageId: `<${messageId}@volume.demo.helix.local>`,
          inReplyTo: null,
          references: [],
          marker: LOCAL_DEMO_VOLUME_MAIL_MARKER,
          sequence: index,
        },
        sent_at: timeline.at(Date.UTC(2026, 4, 1, 12, index % 60, index % 60)).toISOString(),
      });
      states.push({
        actor_id: actorId,
        thread_id: threadId,
        org_id: orgId,
        labels:
          index % 2 === 0 ? ["inbox", "volume", "invoices"] : ["inbox", "volume", "operations"],
        read_at: null,
        starred: index % 17 === 0,
      });
      permissions.push({
        org_id: orgId,
        actor_id: actorId,
        resource_type: "thread",
        resource_id: threadId,
        role: "owner",
        granted_by_actor_id: actorId,
      });
    }

    await insertVolumeMailBatch(sql, {
      threads,
      messages,
      states,
      permissions,
    });
  }
}

async function insertVolumeMailBatch(
  sql: SeedSql,
  batch: {
    readonly threads: readonly VolumeMailThreadRow[];
    readonly messages: readonly VolumeMailMessageRow[];
    readonly states: readonly VolumeMailThreadStateRow[];
    readonly permissions: readonly VolumeMailPermissionRow[];
  },
): Promise<void> {
  await sql`
    insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
    select id, org_id, kind::thread_kind, subject, created_by_actor_id, metadata
    from jsonb_to_recordset(${json(sql, jsonRows(batch.threads))}::jsonb) as row(
      id uuid,
      org_id uuid,
      kind text,
      subject text,
      created_by_actor_id uuid,
      metadata jsonb
    )
  `;
  await sql`
    insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
    select id, org_id, thread_id, actor_id, kind::message_kind, body, body_format, metadata, sent_at
    from jsonb_to_recordset(${json(sql, jsonRows(batch.messages))}::jsonb) as row(
      id uuid,
      org_id uuid,
      thread_id uuid,
      actor_id uuid,
      kind text,
      body text,
      body_format text,
      metadata jsonb,
      sent_at timestamptz
    )
  `;
  await sql`
    insert into mail_thread_state (
      actor_id, thread_id, org_id, labels, archived_at, deleted_at, snoozed_until, read_at, starred, updated_at
    )
    select actor_id, thread_id, org_id, labels, null, null, null, read_at, starred, now()
    from jsonb_to_recordset(${json(sql, jsonRows(batch.states))}::jsonb) as row(
      actor_id uuid,
      thread_id uuid,
      org_id uuid,
      labels text[],
      read_at timestamptz,
      starred boolean
    )
  `;
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    select org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
    from jsonb_to_recordset(${json(sql, jsonRows(batch.permissions))}::jsonb) as row(
      org_id uuid,
      actor_id uuid,
      resource_type text,
      resource_id uuid,
      role text,
      granted_by_actor_id uuid
    )
  `;
}

async function seedChat(
  sql: SeedSql,
  orgId: string,
  actorId: string,
  timeline: DemoTimeline,
): Promise<void> {
  await sql`
    insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
    values (
      ${demoIds.chatRoomLaunch},
      ${orgId},
      'chat_room',
      'Helix launch room',
      ${actorId},
      ${json(sql, { source: LOCAL_DEMO_SOURCE })}
    )
  `;
  await sql`
    insert into chat_room_settings (thread_id, org_id, name, topic, is_private, metadata)
    values (
      ${demoIds.chatRoomLaunch},
      ${orgId},
      'Helix launch room',
      'Coordinate Mail, Drive, Docs, and Calendar launch testing.',
      false,
      ${json(sql, { source: LOCAL_DEMO_SOURCE, color: "blue" })}
    )
  `;
  await grant(sql, orgId, actorId, "thread", demoIds.chatRoomLaunch, "owner", actorId);
  await grant(
    sql,
    orgId,
    demoIds.colleagueActor,
    "thread",
    demoIds.chatRoomLaunch,
    "member",
    actorId,
  );

  const messages = [
    {
      id: demoIds.chatMessageLaunchPlan,
      actorId,
      body: "I loaded the Helix launch room with real seeded Mail, Drive, Docs, and Calendar data for end-to-end testing.",
      sentAt: timeline.at("2026-05-20T13:05:00.000Z"),
    },
    {
      id: demoIds.chatMessageMailDensity,
      actorId: demoIds.colleagueActor,
      body: "Mail density should match the Gmail reference: compact rows, clear unread weight, and messages open in the main content area.",
      sentAt: timeline.at("2026-05-20T13:07:00.000Z"),
    },
    {
      id: demoIds.chatMessageCalendarPreview,
      actorId,
      body: "Calendar preview can collapse, but the launch room should stay searchable from global search and MCP resources.",
      sentAt: timeline.at("2026-05-20T13:10:00.000Z"),
    },
  ] as const;

  for (const message of messages) {
    await sql`
      insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
      values (
        ${message.id},
        ${orgId},
        ${demoIds.chatRoomLaunch},
        ${message.actorId},
        'chat',
        ${message.body},
        'plain',
        ${json(sql, { source: LOCAL_DEMO_SOURCE, room: "launch" })},
        ${message.sentAt}
      )
    `;
  }

  await sql`
    insert into chat_read_receipts (thread_id, actor_id, org_id, last_read_message_id, last_read_at)
    values (
      ${demoIds.chatRoomLaunch},
      ${actorId},
      ${orgId},
      ${demoIds.chatMessageCalendarPreview},
      ${timeline.at("2026-05-20T13:12:00.000Z")}
    )
  `;
  await sql`
    insert into chat_reactions (message_id, actor_id, org_id, emoji)
    values (${demoIds.chatMessageMailDensity}, ${actorId}, ${orgId}, 'ok')
  `;
}

async function grant(
  sql: SeedSql,
  orgId: string,
  actorId: string,
  resourceType: string,
  resourceId: string,
  role: string,
  grantedByActorId: string,
): Promise<void> {
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values (${orgId}, ${actorId}, ${resourceType}, ${resourceId}, ${role}, ${grantedByActorId})
  `;
}

function json(sql: SeedSql, value: postgres.JSONValue): postgres.Parameter {
  return sql.json(value);
}

function jsonRows(rows: readonly object[]): postgres.JSONValue {
  return rows as unknown as postgres.JSONValue;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shaBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeVolumeMailCount(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("volumeSearch.mailMessages must be a non-negative integer");
  }
  return value;
}

export interface DemoTimeline {
  readonly anchorDate: string | null;
  readonly at: (value: string | number | Date) => Date;
}

export function createDemoTimeline(anchorDate: string | Date | undefined): DemoTimeline {
  if (anchorDate === undefined) {
    return {
      anchorDate: null,
      at: (value) => new Date(value),
    };
  }

  const parsedAnchorDate = parseLocalDemoAnchorDate(anchorDate);
  const deltaMs = parsedAnchorDate.getTime() - baseAnchorDayMs;
  return {
    anchorDate: parsedAnchorDate.toISOString().slice(0, 10),
    at: (value) => new Date(new Date(value).getTime() + deltaMs),
  };
}

export function parseLocalDemoAnchorDate(anchorDate: string | Date): Date {
  if (anchorDate instanceof Date) {
    if (Number.isNaN(anchorDate.getTime())) {
      throw new Error("anchorDate must be a valid date");
    }
    return new Date(
      Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth(), anchorDate.getUTCDate()),
    );
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) {
    throw new Error("anchorDate must use YYYY-MM-DD");
  }
  const parsed = new Date(`${anchorDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== anchorDate) {
    throw new Error("anchorDate must be a valid calendar date");
  }
  return parsed;
}

function volumeUuid(group: "4100" | "4200", index: number): string {
  return `00000000-0000-${group}-8000-${index.toString().padStart(12, "0")}`;
}

function demoCellId(tabIndex: number, rowIndex: number, colIndex: number): string {
  const cellIndex = tabIndex * 100 + rowIndex * 10 + colIndex + 1;
  return `00000000-0000-4600-8000-${cellIndex.toString().padStart(12, "0")}`;
}

async function putDemoStorageObject(
  storage: DemoStorageClient | undefined,
  object: {
    readonly key: string;
    readonly body: string | Buffer;
    readonly contentType: string;
    readonly metadata: Record<string, string>;
  },
): Promise<void> {
  if (storage === undefined) {
    return;
  }
  await storage.put({
    key: object.key,
    body: typeof object.body === "string" ? Buffer.from(object.body, "utf8") : object.body,
    contentType: object.contentType,
    metadata: object.metadata,
  });
}

function createLocalDemoStorageFromEnv(): DemoStorageClient | undefined {
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

async function main(): Promise<void> {
  const sql = createSqlClient();
  try {
    const result = await seedLocalDemo(sql, {
      anchorDate: process.env.HELIX_LOCAL_DEMO_ANCHOR_DATE,
      volumeSearch:
        process.env.HELIX_LOCAL_DEMO_VOLUME_SEARCH === "true"
          ? { mailMessages: DEFAULT_LOCAL_DEMO_VOLUME_MAIL_COUNT }
          : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
