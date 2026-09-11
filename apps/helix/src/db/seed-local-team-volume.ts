import { instantToLocalDateTime } from "@helix/contracts";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { chatGovernanceMetadata } from "../platform/chat/governance.js";
import { toSqlJson } from "../platform/util/sql.js";
import {
  ADMIN_CALENDAR_ID,
  volumeActors,
  volumeCounterpart,
  volumeDirectMessages,
  volumeFolderFixtures,
  volumeMailCategory,
  volumeMailSubject,
  volumeRooms,
  VOLUME_ADMIN_ASSISTANT,
  VOLUME_ADMIN_EVENTS,
  VOLUME_ASSISTANT_MESSAGES,
  VOLUME_ASSISTANT_PER_PERSON,
  VOLUME_DM_MESSAGES,
  VOLUME_EVENTS_PER_PERSON,
  VOLUME_EXISTING_DM_EXTRA,
  VOLUME_MAIL_MESSAGES_PER_THREAD,
  VOLUME_MAIL_THREADS_PER_ACTOR,
  VOLUME_ROOM_EXTRA_MESSAGES,
  type VolumeActor,
} from "./local-team-volume.js";
import {
  LOCAL_TEAM_ADMIN,
  LOCAL_TEAM_DIRECT_MESSAGES,
  LOCAL_TEAM_PEOPLE,
  LOCAL_TEAM_ROOMS,
  LOCAL_TEAM_SOURCE,
  teamDay,
  teamId,
  teamPerson,
} from "./local-team-fixtures.js";

type Sql = postgres.TransactionSql;

async function grant(
  sql: Sql,
  orgId: string,
  actorId: string,
  resourceType: string,
  resourceId: string,
  role: string,
  owner: string,
) {
  await sql`insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    select ${orgId}, ${actorId}, ${resourceType}, ${resourceId}, ${role}, ${owner}
    where not exists (
      select 1 from permissions
      where org_id = ${orgId} and actor_id = ${actorId} and resource_type = ${resourceType}
        and resource_id = ${resourceId} and role = ${role} and status = 'active'
    )`;
}

export async function seedTeamVolume(
  sql: Sql,
  orgId: string,
  anchorDate: string,
  withAdmin: boolean,
): Promise<void> {
  await seedVolumeFolders(sql, orgId, withAdmin);
  await seedVolumeMail(sql, orgId, anchorDate, withAdmin);
  await seedVolumeRooms(sql, orgId, anchorDate, withAdmin);
  await seedVolumeDirectMessages(sql, orgId, anchorDate, withAdmin);
  await seedVolumeExistingChat(sql, orgId, anchorDate, withAdmin);
  await seedVolumeAssistant(sql, orgId, anchorDate, withAdmin);
  await seedVolumeCalendar(sql, orgId, anchorDate, withAdmin);
}

async function seedVolumeFolders(sql: Sql, orgId: string, withAdmin: boolean) {
  for (const folder of volumeFolderFixtures(withAdmin)) {
    await sql`insert into drive_folders (id, org_id, name, parent_folder_id, owner_actor_id, created_by_actor_id, metadata)
      values (${folder.id}, ${orgId}, ${folder.name}, ${folder.parentId}, ${folder.ownerActorId}, ${folder.ownerActorId},
        ${sql.json({ source: LOCAL_TEAM_SOURCE })})
      on conflict (id) do nothing`;
    for (const actorId of folder.memberActorIds) {
      await grant(
        sql,
        orgId,
        actorId,
        "drive_folder",
        folder.id,
        actorId === folder.ownerActorId ? "owner" : "editor",
        folder.ownerActorId,
      );
    }
  }
}

async function seedVolumeMail(sql: Sql, orgId: string, anchorDate: string, withAdmin: boolean) {
  const actors = volumeActors(withAdmin);
  for (const actor of actors) {
    for (let thread = 0; thread < VOLUME_MAIL_THREADS_PER_ACTOR; thread += 1) {
      const other = actors[volumeCounterpart(actor.slot, thread, actors.length)];
      if (!other) continue;
      const threadId = teamId(2, 1000 + actor.slot * 200 + thread);
      const subject = volumeMailSubject(actor.slot, thread);
      const inserted =
        await sql`insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
        values (${threadId}, ${orgId}, 'mail', ${subject}, ${actor.actorId}, ${sql.json({ source: LOCAL_TEAM_SOURCE })})
        on conflict (id) do nothing returning id`;
      if (inserted.length === 0) continue;
      const category = volumeMailCategory(thread);
      const unread = thread % 3 === 0;
      const starred = thread % 7 === 0;
      for (let reply = 0; reply < VOLUME_MAIL_MESSAGES_PER_THREAD; reply += 1) {
        const sender = reply === 1 ? other : actor;
        const target = reply === 1 ? actor : other;
        const messageId = teamId(4, 30000 + actor.slot * 800 + thread * 4 + reply);
        const sentAt = teamDay(anchorDate, -40 + (thread % 35), 8 + (reply % 8));
        const body =
          reply === 0
            ? `Hi ${other.firstName},\n\n${subject}. Please confirm the owner and the next step before Thursday.\n\n${actor.displayName}`
            : reply === 1
              ? `Hi ${actor.firstName},\n\nNoted. I will check the shared folder and reply with one concrete improvement.\n\n${other.displayName}`
              : `Thanks ${other.firstName}. I will record the useful failure if anyone cannot open the file.\n\n${actor.displayName}`;
        await sql`insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
          values (${messageId}, ${orgId}, ${threadId}, ${sender.actorId}, 'mail', ${body}, 'plain',
            ${sql.json({
              source: LOCAL_TEAM_SOURCE,
              direction: "outbound",
              from: { address: sender.email, name: sender.displayName },
              to: [{ address: target.email, name: target.displayName }],
              cc: [],
              bcc: [],
              subject,
              messageId: `<${messageId}@demo.helix.local>`,
            })},
            ${sentAt})`;
        for (const participant of [actor, other]) {
          await sql`insert into mail_message_deliveries (org_id, message_id, actor_id, received_at)
            values (${orgId}, ${messageId}, ${participant.actorId},
              ${participant.actorId === sender.actorId ? null : sentAt})
            on conflict do nothing`;
        }
      }
      for (const participant of [actor, other]) {
        await grant(sql, orgId, participant.actorId, "thread", threadId, "owner", actor.actorId);
        await sql`insert into mail_thread_state (actor_id, thread_id, org_id, labels, category, read_at, starred)
          values (${participant.actorId}, ${threadId}, ${orgId}, ${sql.array(["inbox", "sent"], 1009)}, ${category},
            ${unread && participant.actorId === other.actorId ? null : teamDay(anchorDate, -1)},
            ${starred && participant.actorId === actor.actorId})
          on conflict do nothing`;
      }
    }
    await sql`insert into mail_drafts (id, org_id, actor_id, envelope)
      values (${teamId(9, 100 + actor.slot)}, ${orgId}, ${actor.actorId},
        ${sql.json({
          from: { address: actor.email, name: actor.displayName },
          to: [],
          cc: [],
          bcc: [],
          subject: `Draft: ${actor.firstName} follow-up`,
          body: `Notes to send later from ${actor.displayName}.`,
          bodyFormat: "plain",
          attachments: [],
        })})
      on conflict (id) do nothing`;
  }
}

async function seedVolumeRooms(sql: Sql, orgId: string, anchorDate: string, withAdmin: boolean) {
  for (const [roomIndex, room] of volumeRooms().entries()) {
    const owner = teamPerson(room.memberIndexes[0] ?? 0);
    const inserted =
      await sql`insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (${room.id}, ${orgId}, 'chat_room', ${room.name}, ${owner.actorId}, ${sql.json({ source: LOCAL_TEAM_SOURCE })})
      on conflict (id) do nothing returning id`;
    if (inserted.length > 0) {
      await sql`insert into chat_room_settings (thread_id, org_id, name, topic, privacy, participant_key, read_receipts_enabled, metadata)
      values (${room.id}, ${orgId}, ${room.name}, ${room.topic}, 'restricted', null, true,
        ${sql.json(toSqlJson({ source: LOCAL_TEAM_SOURCE, ...chatGovernanceMetadata("chat_room", { spaceType: "project", externalAccess: "internal" }) }))})`;
      for (const index of room.memberIndexes) {
        await grant(
          sql,
          orgId,
          teamPerson(index).actorId,
          "thread",
          room.id,
          index === room.memberIndexes[0] ? "owner" : "member",
          owner.actorId,
        );
      }
      if (withAdmin && room.includeAdmin)
        await grant(
          sql,
          orgId,
          LOCAL_TEAM_ADMIN.actorId,
          "thread",
          room.id,
          "member",
          owner.actorId,
        );
    }
    const speakers = [...room.memberIndexes];
    if (withAdmin && room.includeAdmin) speakers.push(-1);
    for (let index = 0; index < 12; index += 1) {
      const speaker = speakers[index % speakers.length] ?? 0;
      const actorId = speaker < 0 ? LOCAL_TEAM_ADMIN.actorId : teamPerson(speaker).actorId;
      await sql`insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
        values (${teamId(12, 80000 + roomIndex * 20 + index)}, ${orgId}, ${room.id}, ${actorId}, 'chat',
          ${volumeChatLine(room.name, index)}, 'plain', ${sql.json({ source: LOCAL_TEAM_SOURCE })},
          ${new Date(teamDay(anchorDate, -8 + (index % 6), 13).getTime() + index * 120_000)})
        on conflict (id) do nothing`;
    }
  }
}

async function seedVolumeDirectMessages(
  sql: Sql,
  orgId: string,
  anchorDate: string,
  withAdmin: boolean,
) {
  for (const [dmIndex, direct] of volumeDirectMessages(withAdmin).entries()) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:${direct.participantKey}`}, 0))`;
    const prior = await sql<
      { thread_id: string }[]
    >`select thread_id from chat_room_settings where org_id = ${orgId} and participant_key = ${direct.participantKey}`;
    const roomId = prior[0]?.thread_id ?? direct.id;
    if (prior.length === 0) {
      const inserted =
        await sql`insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
        values (${direct.id}, ${orgId}, 'chat_dm', ${`${direct.left.displayName} and ${direct.right.displayName}`}, ${direct.left.actorId},
          ${sql.json({ source: LOCAL_TEAM_SOURCE })})
        on conflict (id) do nothing returning id`;
      if (inserted.length === 0) continue;
      await sql`insert into chat_room_settings (thread_id, org_id, name, topic, privacy, participant_key, read_receipts_enabled, metadata)
        values (${direct.id}, ${orgId}, ${`${direct.left.displayName} and ${direct.right.displayName}`}, 'Harbor working conversation', 'private',
          ${direct.participantKey}, true,
          ${sql.json(toSqlJson({ source: LOCAL_TEAM_SOURCE, ...chatGovernanceMetadata("chat_dm", { spaceType: "project", externalAccess: "internal" }) }))})`;
      await grant(
        sql,
        orgId,
        direct.left.actorId,
        "thread",
        direct.id,
        "owner",
        direct.left.actorId,
      );
      await grant(
        sql,
        orgId,
        direct.right.actorId,
        "thread",
        direct.id,
        "member",
        direct.left.actorId,
      );
    }
    for (let index = 0; index < VOLUME_DM_MESSAGES; index += 1) {
      const sender = index % 2 === 0 ? direct.left : direct.right;
      await sql`insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
        values (${teamId(12, 70000 + dmIndex * 20 + index)}, ${orgId}, ${roomId}, ${sender.actorId}, 'chat',
          ${volumeChatLine("DM", index)}, 'plain', ${sql.json({ source: LOCAL_TEAM_SOURCE })},
          ${new Date(teamDay(anchorDate, -5, 11).getTime() + index * 90_000)})
        on conflict (id) do nothing`;
    }
  }
}

async function seedVolumeExistingChat(
  sql: Sql,
  orgId: string,
  anchorDate: string,
  withAdmin: boolean,
) {
  for (const [roomIndex, room] of LOCAL_TEAM_ROOMS.entries()) {
    for (let index = 0; index < VOLUME_ROOM_EXTRA_MESSAGES; index += 1) {
      const actor = teamPerson(room.members[index % room.members.length] ?? 0);
      await sql`insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
        values (${teamId(12, 60000 + roomIndex * 100 + index)}, ${orgId}, ${room.id}, ${actor.actorId}, 'chat',
          ${volumeChatLine(room.name, index + 8)}, 'plain', ${sql.json({ source: LOCAL_TEAM_SOURCE })},
          ${new Date(teamDay(anchorDate, -4, 16).getTime() + index * 60_000)})
        on conflict (id) do nothing`;
    }
  }
  const existing = [
    ...LOCAL_TEAM_DIRECT_MESSAGES.map((direct) => ({
      id: direct.id,
      participantKey: direct.participantKey,
      members: direct.members.map((index) => teamPerson(index).actorId),
    })),
    ...(withAdmin
      ? [
          {
            id: teamId(3, 201),
            participantKey: createHash("sha256")
              .update([LOCAL_TEAM_ADMIN.actorId, teamPerson(0).actorId].sort().join(","))
              .digest("hex"),
            members: [teamPerson(0).actorId, LOCAL_TEAM_ADMIN.actorId],
          },
        ]
      : []),
  ];
  for (const [dmIndex, direct] of existing.entries()) {
    const prior = await sql<
      { thread_id: string }[]
    >`select thread_id from chat_room_settings where org_id = ${orgId} and participant_key = ${direct.participantKey}`;
    const roomId = prior[0]?.thread_id ?? direct.id;
    for (let index = 0; index < VOLUME_EXISTING_DM_EXTRA; index += 1) {
      const actorId = direct.members[index % direct.members.length] ?? direct.members[0];
      if (!actorId) continue;
      await sql`insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
        values (${teamId(12, 75000 + dmIndex * 20 + index)}, ${orgId}, ${roomId}, ${actorId}, 'chat',
          ${volumeChatLine("follow-up", index)}, 'plain', ${sql.json({ source: LOCAL_TEAM_SOURCE })},
          ${new Date(teamDay(anchorDate, -2, 18).getTime() + index * 45_000)})
        on conflict (id) do nothing`;
    }
  }
}

async function seedVolumeAssistant(
  sql: Sql,
  orgId: string,
  anchorDate: string,
  withAdmin: boolean,
) {
  const owners: VolumeActor[] = [...volumeActors(false)];
  if (withAdmin) {
    owners.push({
      slot: 10,
      actorId: LOCAL_TEAM_ADMIN.actorId,
      email: LOCAL_TEAM_ADMIN.email,
      displayName: LOCAL_TEAM_ADMIN.displayName,
      firstName: LOCAL_TEAM_ADMIN.firstName,
    });
  }
  for (const owner of owners) {
    const count = owner.slot === 10 ? VOLUME_ADMIN_ASSISTANT : VOLUME_ASSISTANT_PER_PERSON;
    for (let conversation = 0; conversation < count; conversation += 1) {
      const id = teamId(6, 1000 + owner.slot * 40 + conversation);
      const title = `${owner.firstName} working thread ${String(conversation + 1)}`;
      const inserted =
        await sql`insert into assistant_conversations (id, org_id, actor_id, title, memory_opt_in, pinned_at, metadata, created_at, updated_at)
        values (${id}, ${orgId}, ${owner.actorId}, ${title}, false, null,
          ${sql.json({ source: LOCAL_TEAM_SOURCE, synthetic: true })},
          ${teamDay(anchorDate, -10 + (conversation % 8), 9)}, ${teamDay(anchorDate, -1, 9)})
        on conflict (id) do nothing returning id`;
      if (inserted.length === 0) continue;
      for (let message = 0; message < VOLUME_ASSISTANT_MESSAGES; message += 1) {
        const role = message % 2 === 0 ? "user" : "assistant";
        const content =
          role === "user"
            ? `Help me with Harbor item ${String(conversation + 1)} today.`
            : `Do the smallest next step, write down the owner, and stop when the example is usable.`;
        await sql`insert into assistant_messages (id, org_id, conversation_id, actor_id, role, content, metadata, created_at)
          values (${teamId(7, 40000 + owner.slot * 200 + conversation * 5 + message)}, ${orgId}, ${id}, ${owner.actorId}, ${role}, ${content},
            ${sql.json({ source: LOCAL_TEAM_SOURCE, synthetic: true })},
            ${new Date(teamDay(anchorDate, -1, 10).getTime() + message * 30_000)})`;
      }
    }
  }
}

async function seedVolumeCalendar(sql: Sql, orgId: string, anchorDate: string, withAdmin: boolean) {
  for (const person of LOCAL_TEAM_PEOPLE) {
    await insertVolumeEvents(
      sql,
      orgId,
      anchorDate,
      person.actorId,
      person.calendarId,
      person.email,
      person.displayName,
      VOLUME_EVENTS_PER_PERSON,
      person.index,
    );
  }
  if (!withAdmin) return;
  const calendar =
    await sql`insert into cal_calendars (id, org_id, owner_actor_id, name, color, timezone, description, metadata)
    values (${ADMIN_CALENDAR_ID}, ${orgId}, ${LOCAL_TEAM_ADMIN.actorId}, 'Harbor admin', '#0f766e', 'America/New_York',
      'Workspace admin review time.', ${sql.json({ source: LOCAL_TEAM_SOURCE })})
    on conflict (id) do nothing returning id`;
  if (calendar.length > 0)
    await grant(
      sql,
      orgId,
      LOCAL_TEAM_ADMIN.actorId,
      "calendar",
      ADMIN_CALENDAR_ID,
      "owner",
      LOCAL_TEAM_ADMIN.actorId,
    );
  await insertVolumeEvents(
    sql,
    orgId,
    anchorDate,
    LOCAL_TEAM_ADMIN.actorId,
    ADMIN_CALENDAR_ID,
    LOCAL_TEAM_ADMIN.email,
    LOCAL_TEAM_ADMIN.displayName,
    VOLUME_ADMIN_EVENTS,
    10,
  );
}

async function insertVolumeEvents(
  sql: Sql,
  orgId: string,
  anchorDate: string,
  actorId: string,
  calendarId: string,
  email: string,
  displayName: string,
  count: number,
  slot: number,
) {
  for (let index = 0; index < count; index += 1) {
    const threadId = teamId(11, 2000 + slot * 40 + index);
    const eventId = teamId(10, 2000 + slot * 40 + index);
    const start = teamDay(anchorDate, -12 + (index % 20), 9 + (index % 6));
    const end = new Date(start.getTime() + 30 * 60_000);
    const title = `Harbor block ${String(index + 1).padStart(2, "0")}`;
    const inserted =
      await sql`insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (${threadId}, ${orgId}, 'calendar', ${title}, ${actorId}, ${sql.json({ source: LOCAL_TEAM_SOURCE })})
      on conflict (id) do nothing returning id`;
    if (inserted.length === 0) continue;
    await sql`insert into cal_events (id, org_id, calendar_id, thread_id, uid, title, description, location, starts_at, ends_at, timezone, starts_local, ends_local, all_day, status, organizer_actor_id, organizer_email, metadata)
      values (${eventId}, ${orgId}, ${calendarId}, ${threadId}, ${`${eventId}@demo.helix.local`}, ${title},
        ${"Bring one decision and the owner of the next step."}, ${index % 4 === 0 ? "Team call" : "Focus time"},
        ${start}, ${end}, 'America/New_York', ${instantToLocalDateTime(start, "America/New_York")}, ${instantToLocalDateTime(end, "America/New_York")}, false, 'confirmed', ${actorId}, ${email},
        ${sql.json({ source: LOCAL_TEAM_SOURCE, visibility: index % 5 === 0 ? "default" : "private", classification: "standard" })})`;
    await sql`insert into cal_attendees (org_id, event_id, actor_id, email, display_name, role, response_status, is_organizer, metadata)
      values (${orgId}, ${eventId}, ${actorId}, ${email}, ${displayName}, 'required', 'accepted', true, ${sql.json({ source: LOCAL_TEAM_SOURCE })})`;
    await grant(sql, orgId, actorId, "thread", threadId, "owner", actorId);
    await grant(sql, orgId, actorId, "event", eventId, "owner", actorId);
  }
}

function volumeChatLine(topic: string, index: number): string {
  const lines = [
    `Checking ${topic}: owner is named on the first line.`,
    "I can open the shared folder from my account.",
    "Personal notes stayed private. That is the useful failure we wanted.",
    "I will mail the next step after Thursday review.",
    "Need one example a teammate can follow without extra setup.",
    "Access-denied copy should name the person to ask.",
    "Restore check passed on staging.",
    "Putting the decision in Mail so it is durable.",
  ];
  return lines[index % lines.length] ?? `Update ${String(index + 1)} on ${topic}.`;
}
