import { instantToLocalDateTime } from "@helix/contracts";
import type postgres from "postgres";
import { chatGovernanceMetadata } from "../platform/chat/governance.js";
import { toSqlJson } from "../platform/util/sql.js";
import {
  LOCAL_TEAM_GROUPS,
  LOCAL_TEAM_DIRECT_MESSAGES,
  LOCAL_TEAM_PEOPLE,
  LOCAL_TEAM_ROOMS,
  LOCAL_TEAM_SHARED_FOLDERS,
  LOCAL_TEAM_SOURCE,
  teamDay,
  teamId,
  teamPerson,
  type TeamPerson,
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
    values (${orgId}, ${actorId}, ${resourceType}, ${resourceId}, ${role}, ${owner})
    on conflict do nothing`;
}

export async function seedTeamContent(sql: Sql, orgId: string, anchorDate: string): Promise<void> {
  for (const group of LOCAL_TEAM_GROUPS) {
    const owner = teamPerson(group.members[0]).actorId;
    const inserted =
      await sql`insert into admin_groups (id, org_id, name, kind, description, created_by)
      values (${group.id}, ${orgId}, ${group.name}, 'security', ${group.description}, ${owner})
      on conflict (id) do nothing returning id`;
    if (inserted.length === 0) continue;
    for (const index of group.members) {
      await sql`insert into admin_group_members (org_id, group_id, actor_id, role, added_by)
        values (${orgId}, ${group.id}, ${teamPerson(index).actorId}, ${index === group.members[0] ? "owner" : "member"}, ${owner})`;
    }
  }
  const folders = [
    ...LOCAL_TEAM_PEOPLE.map((person) => ({
      id: person.folderId,
      name: `${person.firstName}'s Harbor projects`,
      owner: person.index,
      members: [person.index],
    })),
    ...LOCAL_TEAM_SHARED_FOLDERS,
  ];
  for (const folder of folders) {
    const owner = teamPerson(folder.owner).actorId;
    const inserted =
      await sql`insert into drive_folders (id, org_id, name, owner_actor_id, created_by_actor_id, metadata)
      values (${folder.id}, ${orgId}, ${folder.name}, ${owner}, ${owner}, ${sql.json({ source: LOCAL_TEAM_SOURCE })})
      on conflict (id) do nothing returning id`;
    if (inserted.length === 0) continue;
    for (const index of folder.members) {
      await grant(
        sql,
        orgId,
        teamPerson(index).actorId,
        "drive_folder",
        folder.id,
        index === folder.owner ? "owner" : "editor",
        owner,
      );
    }
  }
  for (const person of LOCAL_TEAM_PEOPLE) {
    await seedPersonMail(sql, orgId, person, anchorDate);
    await seedPersonAssistant(sql, orgId, person, anchorDate);
    await seedPersonCalendar(sql, orgId, person, anchorDate);
  }
  for (const room of LOCAL_TEAM_ROOMS) {
    await seedRoom(sql, orgId, room.id, room.name, room.topic, room.members, null, anchorDate);
  }
  for (const direct of LOCAL_TEAM_DIRECT_MESSAGES) {
    const person = teamPerson(direct.members[0] ?? -1);
    const next = teamPerson(direct.members[1] ?? -1);
    await seedRoom(
      sql,
      orgId,
      direct.id,
      `${person.displayName} and ${next.displayName}`,
      "Harbor pilot working conversation",
      direct.members,
      direct.participantKey,
      anchorDate,
    );
  }
}

async function seedPersonMail(sql: Sql, orgId: string, person: TeamPerson, anchorDate: string) {
  for (let topic = 0; topic < 2; topic += 1) {
    const recipient = teamPerson((person.index + topic + 1) % LOCAL_TEAM_PEOPLE.length);
    const sequence = person.index * 2 + topic + 1;
    const threadId = teamId(2, sequence);
    const subject =
      topic === 0
        ? `Harbor review: ${person.documentTitle}`
        : `Thursday pilot handover — ${person.jobTitle.toLowerCase()}`;
    const inserted =
      await sql`insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (${threadId}, ${orgId}, 'mail', ${subject}, ${person.actorId}, ${sql.json({ source: LOCAL_TEAM_SOURCE })})
      on conflict (id) do nothing returning id`;
    if (inserted.length === 0) continue;
    const bodies = [
      `Hi ${recipient.firstName},\n\nI have a first draft of ${person.documentTitle.toLowerCase()} in my Harbor projects folder. The main goal is ${person.focus}. Could you review the acceptance checks before Thursday?\n\nPlease reply with one concrete improvement and any access problem you encounter. I will bring the decision to our pilot review.\n\nThanks,\n${person.displayName}`,
      `Hi ${person.firstName},\n\nThe plan is clear. I suggest adding a short handover example so a teammate can try the flow without extra setup. I will check the shared team handbook and bring my notes to the review.\n\nOne question: who owns the follow-up if a permission check fails?\n\n${recipient.displayName}`,
      `Good suggestion. I added the example to my checklist and will own the follow-up. Let's keep the pilot small, record both a successful path and a useful failure, and share the result in Harbor team lounge.\n\nI have left the working draft private until the review is complete.\n\n${person.displayName}`,
    ];
    for (const [reply, body] of bodies.entries()) {
      const sender = reply === 1 ? recipient : person;
      const target = reply === 1 ? person : recipient;
      const messageId = teamId(4, sequence * 10 + reply);
      const prior =
        reply === 0 ? null : `<${teamId(4, sequence * 10 + reply - 1)}@demo.helix.local>`;
      await sql`insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
        values (${messageId}, ${orgId}, ${threadId}, ${sender.actorId}, 'mail', ${body}, 'plain',
          ${sql.json({ source: LOCAL_TEAM_SOURCE, direction: "outbound", from: { address: sender.email, name: sender.displayName }, to: [{ address: target.email, name: target.displayName }], cc: [], bcc: [], subject, messageId: `<${messageId}@demo.helix.local>`, inReplyTo: prior, references: prior === null ? [] : [prior] })},
          ${teamDay(anchorDate, -3 + topic, 12 + reply)})`;
      for (const participant of [person, recipient]) {
        await sql`insert into mail_message_deliveries (org_id, message_id, actor_id, received_at)
          values (${orgId}, ${messageId}, ${participant.actorId},
            ${participant.actorId === sender.actorId ? null : teamDay(anchorDate, -3 + topic, 12 + reply)})`;
      }
    }
    for (const participant of [person, recipient]) {
      await grant(sql, orgId, participant.actorId, "thread", threadId, "owner", person.actorId);
      await sql`insert into mail_thread_state (actor_id, thread_id, org_id, labels, read_at, starred)
        values (${participant.actorId}, ${threadId}, ${orgId}, ${sql.array(["inbox", "sent", topic === 0 ? "important" : "updates"], 1009)},
          ${topic === 0 ? null : teamDay(anchorDate, -1)}, ${topic === 0 && participant.actorId === person.actorId})`;
    }
  }
  const colleague = teamPerson((person.index + 1) % LOCAL_TEAM_PEOPLE.length);
  await sql`insert into mail_drafts (id, org_id, actor_id, envelope)
    values (${teamId(9, person.index + 1)}, ${orgId}, ${person.actorId},
      ${sql.json({ from: { address: person.email, name: person.displayName }, to: [{ address: colleague.email, name: colleague.displayName }], cc: [], bcc: [], subject: `Draft: ${person.documentTitle} — review follow-up`, body: `Hi ${colleague.firstName},\n\nHere are the next steps from our Harbor review:\n- Confirm the owner.\n- Share the final working file.\n- Check the result together.\n\n`, bodyFormat: "plain", attachments: [] })})
    on conflict (id) do nothing`;
}

async function seedPersonAssistant(
  sql: Sql,
  orgId: string,
  person: TeamPerson,
  anchorDate: string,
) {
  const conversations = [
    {
      title: `Plan my Harbor week`,
      prompt: `Help me plan a practical week as ${person.jobTitle}. My focus is ${person.focus}.`,
      answer: `Start with one outcome: finish ${person.documentTitle.toLowerCase()}.\n\n1. Monday: clarify the acceptance checks with Samara.\n2. Tuesday: prepare a small example and identify the intended audience.\n3. Wednesday: ask a teammate to try it and record what confused them.\n4. Thursday: review the evidence together.\n5. Friday: publish the decision and the next owner.\n\nKeep private drafts private until the team agrees they are ready.`,
    },
    {
      title: `Review ${person.documentTitle.toLowerCase()}`,
      prompt: `What should I check before sharing ${person.documentTitle.toLowerCase()} with the pilot team?`,
      answer: `Check that the file states its purpose, owner, audience, and next decision. Include a useful example, a measurable acceptance check, and one known limitation.\n\nFor your work on ${person.focus}, ask a teammate to follow the instructions from a fresh session. Verify they can open shared resources and cannot open someone else's private drafts.`,
    },
    {
      title: `Write a clear pilot update`,
      prompt: `Draft a short team update about my Harbor work.`,
      answer: `This week I am preparing ${person.documentTitle.toLowerCase()}. The draft covers ${person.focus}.\n\nNext I will ask a teammate to try the example and bring the result to Thursday's review. The open question is whether the handover gives the next owner enough context. Please send one concrete improvement or flag a step you could not complete.`,
    },
  ];
  for (const [index, conversation] of conversations.entries()) {
    const id = teamId(6, person.index * 3 + index + 1);
    const inserted =
      await sql`insert into assistant_conversations (id, org_id, actor_id, title, memory_opt_in, pinned_at, metadata, created_at, updated_at)
      values (${id}, ${orgId}, ${person.actorId}, ${conversation.title}, false, ${index === 0 ? teamDay(anchorDate, -1) : null},
        ${sql.json({ source: LOCAL_TEAM_SOURCE, synthetic: true })}, ${teamDay(anchorDate, -2, 12 + index)}, ${teamDay(anchorDate, -1, 12 + index)})
      on conflict (id) do nothing returning id`;
    if (inserted.length === 0) continue;
    const exchanges = [
      ["user", conversation.prompt],
      ["assistant", conversation.answer],
      ["user", "Make the next step specific enough to act on today."],
      [
        "assistant",
        `Open your ${person.documentTitle.toLowerCase()} working file, add one acceptance check, then message your reviewer with the exact decision you need. Allow 30 minutes and stop when the example is usable.`,
      ],
    ] as const;
    for (const [messageIndex, [role, content]] of exchanges.entries()) {
      await sql`insert into assistant_messages (id, org_id, conversation_id, actor_id, role, content, metadata, created_at)
        values (${teamId(7, (person.index * 3 + index) * 10 + messageIndex + 1)}, ${orgId}, ${id}, ${person.actorId}, ${role}, ${content},
          ${sql.json({ source: LOCAL_TEAM_SOURCE, synthetic: true })}, ${new Date(teamDay(anchorDate, -1, 12 + index).getTime() + messageIndex * 60_000)})`;
    }
  }
}

async function seedPersonCalendar(sql: Sql, orgId: string, person: TeamPerson, anchorDate: string) {
  const calendar =
    await sql`insert into cal_calendars (id, org_id, owner_actor_id, name, color, timezone, description, metadata)
    values (${person.calendarId}, ${orgId}, ${person.actorId}, 'Harbor work', '#0f766e', 'America/New_York', 'Personal pilot work and review time.', ${sql.json({ source: LOCAL_TEAM_SOURCE })})
    on conflict (id) do nothing returning id`;
  if (calendar.length > 0)
    await grant(sql, orgId, person.actorId, "calendar", person.calendarId, "owner", person.actorId);
  const titles = [
    `Focus: ${person.documentTitle}`,
    "Harbor pilot readiness review",
    "Weekly learning notes",
  ];
  for (const [index, title] of titles.entries()) {
    const sequence = person.index * 3 + index + 1;
    const threadId = teamId(11, sequence);
    const eventId = teamId(10, sequence);
    const start = teamDay(anchorDate, index, 14 + index);
    const end = new Date(start.getTime() + (index === 1 ? 45 : 30) * 60_000);
    const inserted =
      await sql`insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (${threadId}, ${orgId}, 'calendar', ${title}, ${person.actorId}, ${sql.json({ source: LOCAL_TEAM_SOURCE })})
      on conflict (id) do nothing returning id`;
    if (inserted.length === 0) continue;
    await sql`insert into cal_events (id, org_id, calendar_id, thread_id, uid, title, description, location, starts_at, ends_at, timezone, starts_local, ends_local, all_day, status, organizer_actor_id, organizer_email, metadata)
      values (${eventId}, ${orgId}, ${person.calendarId}, ${threadId}, ${`${eventId}@demo.helix.local`}, ${title},
        ${`Bring ${person.documentTitle.toLowerCase()}, one acceptance check, and the next decision owner.`}, ${index === 1 ? "Team call — link to be agreed in Chat" : "Focus time"},
        ${start}, ${end}, 'America/New_York', ${instantToLocalDateTime(start, "America/New_York")}, ${instantToLocalDateTime(end, "America/New_York")}, false, 'confirmed', ${person.actorId}, ${person.email},
        ${sql.json({ source: LOCAL_TEAM_SOURCE, visibility: index === 1 ? "default" : "private", classification: "standard" })})`;
    await sql`insert into cal_attendees (org_id, event_id, actor_id, email, display_name, role, response_status, is_organizer, metadata)
      values (${orgId}, ${eventId}, ${person.actorId}, ${person.email}, ${person.displayName}, 'required', 'accepted', true, ${sql.json({ source: LOCAL_TEAM_SOURCE })})`;
    await grant(sql, orgId, person.actorId, "thread", threadId, "owner", person.actorId);
    await grant(sql, orgId, person.actorId, "event", eventId, "owner", person.actorId);
  }
}

async function seedRoom(
  sql: Sql,
  orgId: string,
  id: string,
  name: string,
  topic: string,
  members: readonly number[],
  participantKey: string | null,
  anchorDate: string,
) {
  const owner = teamPerson(members[0] ?? -1);
  const direct = participantKey !== null;
  if (participantKey)
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:${participantKey}`}, 0))`;
  const prior = participantKey
    ? await sql<
        { thread_id: string }[]
      >`select thread_id from chat_room_settings where org_id = ${orgId} and participant_key = ${participantKey}`
    : [];
  const roomId = prior[0]?.thread_id ?? id;
  const inserted =
    prior.length > 0
      ? []
      : await sql`insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
    values (${id}, ${orgId}, ${direct ? "chat_dm" : "chat_room"}, ${name}, ${owner.actorId}, ${sql.json({ source: LOCAL_TEAM_SOURCE })})
    on conflict (id) do nothing returning id`;
  if (prior.length === 0 && inserted.length === 0) return;
  if (prior.length === 0) {
    await sql`insert into chat_room_settings (thread_id, org_id, name, topic, privacy, participant_key, read_receipts_enabled, metadata)
      values (${id}, ${orgId}, ${name}, ${topic}, ${direct ? "private" : "restricted"}, ${participantKey}, true,
        ${sql.json(toSqlJson({ source: LOCAL_TEAM_SOURCE, ...chatGovernanceMetadata(direct ? "chat_dm" : "chat_room", { spaceType: "project", externalAccess: "internal" }) }))})`;
    for (const index of members) {
      await grant(
        sql,
        orgId,
        teamPerson(index).actorId,
        "thread",
        id,
        index === members[0] ? "owner" : "member",
        owner.actorId,
      );
    }
  }
  const lines = direct
    ? [
        "Do you have fifteen minutes to review my Harbor working draft today?",
        "Yes. Please send the decision you need and I will check the acceptance example first.",
        "The main question is whether the next owner can follow the handover without extra setup. I left the working file private until it is ready.",
        "That makes sense. I will reply with one concrete improvement before the readiness review.",
      ]
    : [
        `Welcome to ${name}. ${topic}`,
        "Today's goal: make one part of the pilot easier for the next person to use.",
        "I updated my working notes with an owner, an example, and an acceptance check.",
        "Please check access from your own account before calling a shared resource ready.",
        "I can review the handover this afternoon. A useful failure example would help too.",
        "Good point. We should record what happens when a person is outside the intended audience.",
        "The next review is on the Harbor work calendar. Bring one decision, not a long status report.",
        "Thanks everyone. I will put the agreed next steps in Mail after the review.",
      ];
  for (const [index, body] of lines.entries()) {
    const actor = teamPerson(members[index % members.length] ?? -1);
    const suffix = Number(id.slice(-12));
    await sql`insert into messages (id, org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
      values (${teamId(12, suffix * 100 + index)}, ${orgId}, ${roomId}, ${actor.actorId}, 'chat', ${body}, 'plain',
        ${sql.json({ source: LOCAL_TEAM_SOURCE })}, ${new Date(teamDay(anchorDate, -1, 15).getTime() + index * 300_000)}) on conflict (id) do nothing`;
  }
}
