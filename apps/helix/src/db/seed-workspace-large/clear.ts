/**
 * Cleanup for the large workspace seed.
 *
 * Deletes every row whose metadata/payload carries
 * `source = 'workspace-seed-large'`, in FK-safe order.
 * The light seed (`workspace-seed`) is never touched.
 */

import { ADMIN_ACTOR, USER_ACTOR, WORKSPACE_SEED_LARGE_SOURCE, type SeedSql } from "./config.js";

export async function clearWorkspaceLarge(sql: SeedSql, orgId: string): Promise<void> {
  const SRC = WORKSPACE_SEED_LARGE_SOURCE;

  // Collect IDs before we start deleting so FK sub-selects stay consistent.
  const seededThreads = await sql<{ readonly id: string }[]>`
    select id from threads
    where org_id = ${orgId} and metadata->>'source' = ${SRC}
  `;
  const threadIds = seededThreads.map((r) => r.id);

  const seededObjects = await sql<{ readonly id: string }[]>`
    select id from objects
    where org_id = ${orgId} and metadata->>'source' = ${SRC}
  `;
  const objectIds = seededObjects.map((r) => r.id);

  const UUID_OID = 2950;
  const inThreads = sql.array(threadIds.length > 0 ? threadIds : [orgId], UUID_OID);
  const inObjects = sql.array(objectIds.length > 0 ? objectIds : [orgId], UUID_OID);
  const grantActors = sql.array([ADMIN_ACTOR, USER_ACTOR], UUID_OID);

  // Permissions referencing seeded threads or objects.
  await sql`delete from permissions where org_id = ${orgId} and granted_by_actor_id = any(${grantActors}) and resource_id = any(${inThreads})`;
  await sql`delete from permissions where org_id = ${orgId} and granted_by_actor_id = any(${grantActors}) and resource_id = any(${inObjects})`;
  // Surface-specific permissions keyed outside thread/object ranges.
  await sql`
    delete from permissions
    where org_id = ${orgId}
      and granted_by_actor_id = any(${grantActors})
      and resource_type in ('calendar','event','document','sheet','slide_deck','meet_room','folder')
      and resource_id::text like '00000000-0000-4000-8000-b%'
  `;
  // Actor permissions for large-seed teammate actors.
  await sql`
    delete from permissions
    where org_id = ${orgId}
      and actor_id::text like '00000000-0000-4000-8000-b000%'
  `;

  // Meet.
  await sql`delete from meet_rooms where org_id = ${orgId} and thread_id = any(${inThreads})`;

  // Chat satellite tables.
  await sql`delete from chat_reactions where org_id = ${orgId} and message_id in (select id from messages where thread_id = any(${inThreads}))`;
  await sql`delete from chat_pins where org_id = ${orgId} and thread_id = any(${inThreads})`;
  await sql`delete from chat_read_receipts where org_id = ${orgId} and thread_id = any(${inThreads})`;
  await sql`delete from chat_room_settings where org_id = ${orgId} and thread_id = any(${inThreads})`;

  // Calendar.
  await sql`delete from cal_calendar_memberships where org_id = ${orgId} and calendar_id in (select id from cal_calendars where org_id = ${orgId} and metadata->>'source' = ${SRC})`;
  await sql`delete from cal_attendees where org_id = ${orgId} and event_id in (select id from cal_events where org_id = ${orgId} and metadata->>'source' = ${SRC})`;
  await sql`delete from cal_events where org_id = ${orgId} and metadata->>'source' = ${SRC}`;
  await sql`delete from cal_calendars where org_id = ${orgId} and metadata->>'source' = ${SRC}`;

  // Docs.
  await sql`delete from docs_comments where org_id = ${orgId} and document_id in (select id from docs_documents where org_id = ${orgId} and metadata->>'source' = ${SRC})`;
  await sql`delete from docs_updates where org_id = ${orgId} and document_id in (select id from docs_documents where org_id = ${orgId} and metadata->>'source' = ${SRC})`;
  await sql`delete from docs_documents where org_id = ${orgId} and metadata->>'source' = ${SRC}`;

  // Sheets.
  await sql`delete from sheet_cells where org_id = ${orgId} and sheet_tab_id in (select t.id from sheet_tabs t join sheets s on s.id = t.sheet_id where s.org_id = ${orgId} and s.metadata->>'source' = ${SRC})`;
  await sql`delete from sheet_tabs where org_id = ${orgId} and sheet_id in (select id from sheets where org_id = ${orgId} and metadata->>'source' = ${SRC})`;
  await sql`delete from sheets where org_id = ${orgId} and metadata->>'source' = ${SRC}`;

  // Slides.
  await sql`delete from slides where org_id = ${orgId} and deck_id in (select id from slide_decks where org_id = ${orgId} and metadata->>'source' = ${SRC})`;
  await sql`delete from slide_decks where org_id = ${orgId} and metadata->>'source' = ${SRC}`;

  // Mail + message attachments.
  await sql`delete from message_attachments where message_id in (select id from messages where thread_id = any(${inThreads}))`;
  await sql`delete from mail_thread_state where org_id = ${orgId} and thread_id = any(${inThreads})`;
  // mail_labels has no metadata column — delete by the known c200-group ID prefix.
  await sql`delete from mail_labels where org_id = ${orgId} and id::text like '00000000-0000-4000-8000-c200%'`;

  // Messages.
  await sql`delete from messages where thread_id = any(${inThreads})`;

  // Drive versions + objects.
  await sql`delete from drive_versions where org_id = ${orgId} and object_id = any(${inObjects})`;
  await sql`delete from objects where org_id = ${orgId} and metadata->>'source' = ${SRC}`;
  await sql`delete from drive_folders where org_id = ${orgId} and metadata->>'source' = ${SRC}`;

  // Activity + threads last.
  await sql`delete from activity where org_id = ${orgId} and payload->>'source' = ${SRC}`;
  await sql`delete from threads where org_id = ${orgId} and metadata->>'source' = ${SRC}`;

  // Teammate actors tagged with this seed.
  await sql`delete from actors where org_id = ${orgId} and metadata->>'source' = ${SRC}`;
}
