import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL === undefined ? null : postgres(DATABASE_URL, { max: 4 });

describe("0124 chat moderation migration", () => {
  it("keeps moderation tenant-scoped, role-checked, append-only, and on canonical events", async () => {
    const migration = await readFile(new URL("./0124_chat_moderation.sql", import.meta.url), "utf8");
    expect(migration).toContain("foreign key (org_id, room_id) references threads(org_id, id)");
    expect(migration).toContain("foreign key (org_id, case_id) references chat_moderation_cases(org_id, id)");
    expect(migration).toContain("helix_chat_is_room_moderator");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("append_chat_room_event");
    expect(migration).toContain("chat_moderation_case_events_no_update_or_delete");
    expect(migration).toContain("chat_abuse_signals_emit_outbox");
  });
});

describe.skipIf(sql === null)("0124 live chat moderation playbooks", () => {
  const database = sql as postgres.Sql;
  const orgA = "c1300000-0000-4000-8000-000000000001";
  const orgB = "c1300000-0000-4000-8000-000000000002";
  const owner = "c1300000-0000-4000-8000-000000000011";
  const moderator = "c1300000-0000-4000-8000-000000000012";
  const peerModerator = "c1300000-0000-4000-8000-000000000013";
  const member = "c1300000-0000-4000-8000-000000000014";
  const spammer = "c1300000-0000-4000-8000-000000000015";
  const compromised = "c1300000-0000-4000-8000-000000000016";
  const guest = "c1300000-0000-4000-8000-000000000017";
  const outsider = "c1300000-0000-4000-8000-000000000018";
  const room = "c1300000-0000-4000-8000-000000000021";
  const dm = "c1300000-0000-4000-8000-000000000022";
  const roomB = "c1300000-0000-4000-8000-000000000023";

  beforeAll(async () => {
    await cleanup();
    await database`
      insert into orgs (id, slug, display_name, status, tier, region) values
        (${orgA}, 'chat13-a', 'CHAT 13 A', 'active', 'business', 'test'),
        (${orgB}, 'chat13-b', 'CHAT 13 B', 'active', 'business', 'test')
    `;
    await database`
      insert into actors (id, org_id, type, display_name) values
        (${owner}, ${orgA}, 'user', 'Owner'),
        (${moderator}, ${orgA}, 'user', 'Moderator'),
        (${peerModerator}, ${orgA}, 'user', 'Peer moderator'),
        (${member}, ${orgA}, 'user', 'Member'),
        (${spammer}, ${orgA}, 'user', 'Spammer'),
        (${compromised}, ${orgA}, 'user', 'Compromised'),
        (${guest}, ${orgA}, 'user', 'Guest'),
        (${outsider}, ${orgB}, 'user', 'Outsider')
    `;
    await database`
      update organization_memberships set guest_type = 'external' where actor_id = ${guest}
    `;
    await database`
      insert into threads (id, org_id, kind, subject, created_by_actor_id) values
        (${room}, ${orgA}, 'chat_room', 'Moderation', ${owner}),
        (${dm}, ${orgA}, 'chat_dm', 'DM', ${owner}),
        (${roomB}, ${orgB}, 'chat_room', 'Other tenant', ${outsider})
    `;
    await database`
      insert into chat_room_settings (thread_id, org_id, participant_key) values
        (${room}, ${orgA}, null),
        (${dm}, ${orgA}, 'chat13-dm'),
        (${roomB}, ${orgB}, null)
    `;
    await database`
      insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
      values
        (${orgA}, ${owner}, 'thread', ${room}, 'owner', ${owner}),
        (${orgA}, ${moderator}, 'thread', ${room}, 'moderator', ${owner}),
        (${orgA}, ${peerModerator}, 'thread', ${room}, 'moderator', ${owner}),
        (${orgA}, ${member}, 'thread', ${room}, 'member', ${owner}),
        (${orgA}, ${spammer}, 'thread', ${room}, 'member', ${owner}),
        (${orgA}, ${compromised}, 'thread', ${room}, 'member', ${owner}),
        (${orgA}, ${guest}, 'thread', ${room}, 'member', ${owner}),
        (${orgA}, ${member}, 'thread', ${dm}, 'owner', ${member}),
        (${orgA}, ${guest}, 'thread', ${dm}, 'member', ${member}),
        (${orgB}, ${outsider}, 'thread', ${roomB}, 'owner', ${outsider})
    `;
  });

  afterAll(async () => {
    await cleanup();
    await database.end();
  });

  it("executes harassment, spam, compromise, malicious-file, and guest-abuse playbooks", async () => {
    const harassmentMessage = await send(guest, room, "harassing message");
    const harassmentCase = await report(member, room, harassmentMessage, guest, "harassment", {
      excerptHash: "sha256:harassment",
    });
    await moderate(moderator, harassmentCase, "remove_message", "Harassment confirmed");
    const removed = await database<{ deleted_at: Date | null }[]>`
      select deleted_at from messages where id = ${harassmentMessage}
    `;
    expect(removed[0]?.deleted_at).toBeInstanceOf(Date);

    const maliciousMessage = await send(guest, room, "download this payload");
    const objectRows = await database<{ id: string }[]>`
      insert into objects (org_id, owner_actor_id, kind, storage_key, mime_type, byte_size)
      values (${orgA}, ${guest}, 'file', 'chat13/eicar', 'application/octet-stream', 68)
      returning id
    `;
    const objectId = objectRows[0]?.id ?? "";
    await database.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${orgA}, true)`;
      await tx`select set_config('helix.actor_id', ${guest}, true)`;
      await tx`
        insert into message_attachments (org_id, message_id, object_id)
        values (${orgA}, ${maliciousMessage}, ${objectId})
      `;
    });
    const maliciousCase = await report(
      member,
      room,
      maliciousMessage,
      guest,
      "malicious_attachment",
      { objectId, scannerVerdict: "malicious", sha256: "eicar" },
    );
    await moderate(moderator, maliciousCase, "remove_message", "Scanner verdict confirmed");

    const spamMessage = await send(spammer, room, "bulk spam");
    const spamCase = await report(member, room, spamMessage, spammer, "spam", {
      duplicateCount: 20,
    });
    await moderate(moderator, spamCase, "ban_actor", "Repeated bulk spam");
    await expect(send(spammer, room, "ban bypass")).rejects.toMatchObject({ code: "42501" });

    const compromiseMessage = await send(compromised, room, "suspicious login blast");
    const compromiseCase = await report(
      member,
      room,
      compromiseMessage,
      compromised,
      "compromised_account",
      { impossibleTravel: true },
    );
    await moderate(moderator, compromiseCase, "ban_actor", "Contain compromised account");
    await asActor(compromised, (tx) => tx`
      select helix_appeal_chat_case(
        ${orgA}, ${compromised}, ${compromiseCase}, 'Account recovered',
        '{"credentialReset":true}'::jsonb
      )
    `);
    await moderate(moderator, compromiseCase, "uphold", "Review still pending");

    const guestCase = await report(member, room, null, guest, "guest_abuse", {
      invitationDomain: "external.example",
    });
    await moderate(moderator, guestCase, "dismiss", "Guest controls contain the incident");

    const queue = await asActor(moderator, (tx) => tx<
      { category: string; event_count: number; resolution: string | null }[]
    >`
      select moderation_case.category, moderation_case.resolution, count(event.id)::integer event_count
      from chat_moderation_cases moderation_case
      join chat_moderation_case_events event on event.case_id = moderation_case.id
        and event.org_id = moderation_case.org_id
      where moderation_case.room_id = ${room}
      group by moderation_case.id order by moderation_case.category
    `);
    expect(new Set(queue.map((item) => item.category))).toEqual(
      new Set(["harassment", "spam", "compromised_account", "malicious_attachment", "guest_abuse"]),
    );
    expect(queue.find((item) => item.category === "compromised_account")?.event_count).toBe(4);

    await expect(
      asActor(member, (tx) => tx`
        select helix_moderate_chat_case(
          ${orgA}, ${member}, ${guestCase}, 'dismiss', '', null, '{}'::jsonb
        )
      `),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asActor(outsider, (tx) => tx`
        select helix_report_chat_abuse(
          ${orgA}, ${outsider}, ${room}, null, ${guest}, 'guest_abuse', 'cross tenant', '{}'::jsonb
        )
      `),
    ).rejects.toMatchObject({ code: "42501" });

    const peerMessage = await send(peerModerator, room, "moderator message");
    const peerCase = await report(member, room, peerMessage, peerModerator, "other", {});
    await expect(
      moderate(moderator, peerCase, "ban_actor", "peer escalation"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("enforces blocks, slow mode, content rules, guest controls, abuse signals, and immutable evidence", async () => {
    await asActor(member, (tx) => tx`
      select helix_set_chat_block(${orgA}, ${member}, ${guest}, true, 'unwanted contact')
    `);
    await expect(send(guest, dm, "blocked DM")).rejects.toMatchObject({ code: "42501" });
    await asActor(member, (tx) => tx`
      select helix_set_chat_block(${orgA}, ${member}, ${guest}, false, '')
    `);
    await expect(send(guest, dm, "DM after unblock")).resolves.toBeTruthy();

    await configure({ slow: 60, blocked: ["forbidden"], formats: ["plain"], guests: false });
    await expect(send(guest, room, "guest blocked")).rejects.toMatchObject({ code: "42501" });
    await expect(send(member, room, "forbidden content")).rejects.toMatchObject({ code: "23514" });
    await expect(send(member, room, "format", "html")).rejects.toMatchObject({ code: "23514" });
    await send(member, room, "slow first");
    await expect(send(member, room, "slow second")).rejects.toMatchObject({ code: "23514" });

    await configure({ slow: 0, blocked: [], formats: ["plain", "markdown"], guests: true });
    for (let index = 0; index < 5; index += 1) await send(member, room, `rate ${String(index)}`);
    const signals = await asActor(moderator, (tx) => tx<{ signal_type: string }[]>`
      select signal_type from chat_abuse_signals where room_id = ${room}
    `);
    expect(signals.some((signal) => signal.signal_type === "message_rate")).toBe(true);
    const memberSignals = await asActor(member, (tx) => tx<{ id: string }[]>`
      select id from chat_abuse_signals where room_id = ${room}
    `);
    expect(memberSignals).toEqual([]);
    await expect(
      asActor(moderator, (tx) => tx`
        insert into chat_abuse_signals (org_id, room_id, actor_id, signal_type, score)
        values (${orgA}, ${room}, ${member}, 'spam', 100)
      `),
    ).rejects.toMatchObject({ code: "42501" });

    const caseRows = await database<{ id: string }[]>`
      select id from chat_moderation_cases where category = 'malicious_attachment' and org_id = ${orgA}
    `;
    const evidenceRows = await database<{ id: string }[]>`
      select id from chat_moderation_case_events where case_id = ${caseRows[0]?.id ?? ""} limit 1
    `;
    await expect(database`
      update chat_moderation_case_events set evidence = '{}' where id = ${evidenceRows[0]?.id ?? ""}
    `).rejects.toMatchObject({ code: "23000" });

    const moderationOutbox = await database<{ count: number }[]>`
      select count(*)::integer count from outbox where subject like 'activity.chat.moderation.%'
    `;
    const deletionEvents = await database<{ count: number }[]>`
      select count(*)::integer count from chat_room_events
      where room_id = ${room} and event ->> 'type' = 'message.deleted'
    `;
    expect(moderationOutbox[0]?.count).toBeGreaterThan(15);
    expect(deletionEvents[0]?.count).toBe(2);
    const catalog = await database<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      app_can_mutate: boolean;
    }[]>`
      select relation.relrowsecurity, relation.relforcerowsecurity,
        has_table_privilege('helix_app', relation.oid, 'insert,update,delete') app_can_mutate
      from pg_class relation
      where relation.relname in (
        'chat_moderation_cases', 'chat_moderation_case_events', 'chat_user_blocks',
        'chat_room_bans', 'chat_abuse_signals'
      )
    `;
    expect(catalog).toHaveLength(5);
    expect(catalog.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    expect(catalog.every((row) => !row.app_can_mutate)).toBe(true);
  });

  async function asActor<T>(
    actorId: string,
    callback: (tx: postgres.TransactionSql) => Promise<T>,
    actorOrgId = orgA,
  ): Promise<T> {
    return database.begin(async (tx) => {
      await tx.unsafe("set local role helix_app");
      await tx`
        select set_config('helix.org_id', ${actorOrgId}, true),
          set_config('helix.actor_id', ${actorId}, true)
      `;
      return callback(tx);
    }) as Promise<T>;
  }

  async function send(actorId: string, targetRoom: string, body: string, format = "plain") {
    return asActor(actorId, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        insert into messages (org_id, thread_id, actor_id, kind, body, body_format)
        values (${orgA}, ${targetRoom}, ${actorId}, 'chat', ${body}, ${format}) returning id
      `;
      return rows[0]?.id ?? "";
    });
  }

  async function report(
    reporter: string,
    targetRoom: string,
    messageId: string | null,
    subject: string,
    category: string,
    evidence: Record<string, unknown>,
  ) {
    return asActor(reporter, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        select helix_report_chat_abuse(
          ${orgA}, ${reporter}, ${targetRoom}, ${messageId}, ${subject}, ${category},
          'Incident response playbook', ${tx.json(evidence as postgres.JSONValue)}
        ) id
      `;
      return rows[0]?.id ?? "";
    });
  }

  async function moderate(actorId: string, caseId: string, action: string, reason: string) {
    return asActor(actorId, (tx) => tx`
      select helix_moderate_chat_case(
        ${orgA}, ${actorId}, ${caseId}, ${action}, ${reason}, null,
        '{"reviewed":true}'::jsonb
      )
    `);
  }

  async function configure(input: {
    slow: number;
    blocked: string[];
    formats: string[];
    guests: boolean;
  }) {
    return asActor(moderator, (tx) => tx`
      select helix_configure_chat_moderation(
        ${orgA}, ${moderator}, ${room}, ${input.slow}, ${input.blocked}, ${input.formats}, ${input.guests}
      )
    `);
  }

  async function cleanup() {
    await database.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx`delete from chat_moderation_case_events where org_id in (${orgA}, ${orgB})`;
      await tx`delete from chat_abuse_signals where org_id in (${orgA}, ${orgB})`;
      await tx`delete from chat_room_bans where org_id in (${orgA}, ${orgB})`;
      await tx`delete from chat_user_blocks where org_id in (${orgA}, ${orgB})`;
      await tx`delete from chat_moderation_cases where org_id in (${orgA}, ${orgB})`;
      await tx`delete from chat_room_events where org_id in (${orgA}, ${orgB})`;
      await tx`
        delete from message_attachments where message_id in (
          select id from messages where org_id in (${orgA}, ${orgB})
        )
      `;
      await tx`delete from messages where org_id in (${orgA}, ${orgB})`;
      await tx`delete from objects where org_id in (${orgA}, ${orgB})`;
      await tx`delete from permissions where org_id in (${orgA}, ${orgB})`;
      await tx`delete from chat_room_settings where org_id in (${orgA}, ${orgB})`;
      await tx`delete from threads where org_id in (${orgA}, ${orgB})`;
      await tx`delete from organization_memberships where actor_id in (
        ${owner}, ${moderator}, ${peerModerator}, ${member}, ${spammer}, ${compromised}, ${guest}, ${outsider}
      )`;
      await tx`delete from actors where id in (
        ${owner}, ${moderator}, ${peerModerator}, ${member}, ${spammer}, ${compromised}, ${guest}, ${outsider}
      )`;
      await tx`delete from orgs where id in (${orgA}, ${orgB})`;
    });
  }
});
