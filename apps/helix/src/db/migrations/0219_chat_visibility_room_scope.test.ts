import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";

const ORG = "f2190000-0000-4000-8000-000000000001";
const FOREIGN_ORG = "f2190000-0000-4000-8000-000000000002";
const FILLER_ORG = "f2190000-0000-4000-8000-000000000003";

const actors = {
  owner: "f2190000-0000-4000-8000-000000000101",
  member: "f2190000-0000-4000-8000-000000000102",
  moderator: "f2190000-0000-4000-8000-000000000103",
  former: "f2190000-0000-4000-8000-000000000104",
  expired: "f2190000-0000-4000-8000-000000000105",
  future: "f2190000-0000-4000-8000-000000000106",
  disabled: "f2190000-0000-4000-8000-000000000107",
  suspended: "f2190000-0000-4000-8000-000000000108",
  grouped: "f2190000-0000-4000-8000-000000000109",
  agent: "f2190000-0000-4000-8000-000000000110",
  outsider: "f2190000-0000-4000-8000-000000000111",
  foreign: "f2190000-0000-4000-8000-000000000201",
} as const;

const rooms = {
  full: "f2190000-0000-4000-8000-000000000301",
  sinceJoin: "f2190000-0000-4000-8000-000000000302",
  historyOff: "f2190000-0000-4000-8000-000000000303",
  retention: "f2190000-0000-4000-8000-000000000304",
  legalHold: "f2190000-0000-4000-8000-000000000305",
  discoverable: "f2190000-0000-4000-8000-000000000306",
  dm: "f2190000-0000-4000-8000-000000000307",
  noSettings: "f2190000-0000-4000-8000-000000000308",
  mailThread: "f2190000-0000-4000-8000-000000000309",
  missing: "f2190000-0000-4000-8000-000000000399",
  foreign: "f2190000-0000-4000-8000-000000000401",
} as const;

/** Message ages, in hours before the statement time: old, last week, recent, now. */
const SENT_AGES_HOURS = [24 * 400, 24 * 10, 24 * 3, 1] as const;
const GROUP = "f2190000-0000-4000-8000-000000000501";

/** The predicate exactly as migration 0144 defined it, kept as the oracle. */
function originalDefinition(): string {
  const source = readFileSync(new URL("./0144_chat_governed_spaces.sql", import.meta.url), "utf8");
  const start = source.indexOf("create function helix_chat_message_visible_to(");
  const end = source.indexOf("$$;", start) + "$$;".length;
  if (start < 0 || end <= start) throw new Error("0144 visibility predicate not found");
  return source
    .slice(start, end)
    .replace(
      "create function helix_chat_message_visible_to(",
      "create function pg_temp.chat_visible_0144(",
    );
}

interface MatrixRow {
  readonly actor: string;
  readonly org: string;
  readonly room: string;
  readonly age: number;
  readonly original: boolean;
  readonly scoped: boolean;
}

const skip = skipUnlessLiveDatabase("0219 chat visibility room scope");

describe("0219 chat visibility room scope", { skip }, () => {
  // One connection: the oracle is a temporary function on this session.
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL ?? "", { max: 1, prepare: false, onnotice: () => {} });
    await cleanupTestTenants(sql, [ORG, FOREIGN_ORG, FILLER_ORG]);
    await sql.unsafe(originalDefinition());
    await seedFixtures(sql);
  }, 60_000);

  afterAll(async () => {
    await cleanupTestTenants(sql, [ORG, FOREIGN_ORG, FILLER_ORG]);
    await sql.end();
  }, 60_000);

  it("returns exactly the original result for every actor, org, room and message age", async () => {
    const matrix = await sql<MatrixRow[]>`
      select
        actor.id::text as actor,
        org.id::text as org,
        room.id::text as room,
        age.hours as age,
        pg_temp.chat_visible_0144(org.id, actor.id, room.id, sent.at) as original,
        helix_chat_message_visible_to(org.id, actor.id, room.id, sent.at) as scoped
      from unnest(${Object.values(actors)}::uuid[]) actor(id)
      cross join unnest(${[ORG, FOREIGN_ORG]}::uuid[]) org(id)
      cross join unnest(${Object.values(rooms)}::uuid[]) room(id)
      cross join unnest(${[...SENT_AGES_HOURS]}::integer[]) age(hours)
      cross join lateral (
        select statement_timestamp() - make_interval(hours => age.hours) as at
      ) sent
    `;
    const size =
      Object.keys(actors).length * 2 * Object.keys(rooms).length * SENT_AGES_HOURS.length;
    expect(matrix).toHaveLength(size);
    expect(matrix.filter((row) => row.original !== row.scoped)).toEqual([]);

    const visible = (actor: string, room: string, age: number, org: string = ORG) =>
      matrix.find(
        (row) => row.actor === actor && row.room === room && row.age === age && row.org === org,
      )?.scoped;
    const [old, lastWeek, recent, now] = SENT_AGES_HOURS;
    // The matrix exercises both outcomes of every rule, not one constant answer.
    expect(visible(actors.member, rooms.full, now)).toBe(true);
    expect(visible(actors.moderator, rooms.full, old)).toBe(true);
    expect(visible(actors.grouped, rooms.full, now)).toBe(true);
    expect(visible(actors.grouped, rooms.discoverable, now)).toBe(true);
    expect(visible(actors.agent, rooms.full, now)).toBe(true);
    expect(visible(actors.member, rooms.dm, now)).toBe(true);
    expect(visible(actors.outsider, rooms.dm, now)).toBe(false);
    expect(visible(actors.outsider, rooms.discoverable, now)).toBe(false);
    for (const denied of [
      actors.former,
      actors.expired,
      actors.future,
      actors.disabled,
      actors.suspended,
      actors.outsider,
    ]) {
      expect(visible(denied, rooms.full, now)).toBe(false);
    }
    expect(visible(actors.member, rooms.sinceJoin, lastWeek)).toBe(false);
    expect(visible(actors.member, rooms.sinceJoin, recent)).toBe(true);
    expect(visible(actors.owner, rooms.historyOff, now)).toBe(false);
    expect(visible(actors.member, rooms.retention, old)).toBe(false);
    expect(visible(actors.member, rooms.retention, lastWeek)).toBe(true);
    expect(visible(actors.member, rooms.legalHold, old)).toBe(true);
    expect(visible(actors.owner, rooms.noSettings, now)).toBe(false);
    expect(visible(actors.member, rooms.mailThread, now)).toBe(false);
    expect(visible(actors.foreign, rooms.foreign, now, FOREIGN_ORG)).toBe(true);
    expect(visible(actors.foreign, rooms.foreign, now)).toBe(false);
    expect(visible(actors.owner, rooms.full, now, FOREIGN_ORG)).toBe(false);
    expect(visible(actors.member, rooms.foreign, now, FOREIGN_ORG)).toBe(false);
  }, 60_000);

  it("reads only the asked room's grant instead of every grant in the database", async () => {
    const filler = await seedFiller(sql);
    const reads = (predicate: "original" | "scoped", actorId: string) =>
      sql.begin(async (tx) => {
        // Rows read by sequential and index scans. The session's counters also
        // hold earlier unflushed transactions, so measure a delta around the call.
        const counters = async () => {
          const rows = await tx<{ table: string; rows: string }[]>`
            select
              relname as table,
              (coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0))::text as rows
            from pg_stat_xact_user_tables
            where relid in ('public.permissions'::regclass, 'public.chat_room_settings'::regclass)
          `;
          const read = (table: string) =>
            Number(rows.find((row) => row.table === table)?.rows ?? 0);
          return { permissions: read("permissions"), settings: read("chat_room_settings") };
        };
        const before = await counters();
        const [result] =
          predicate === "original"
            ? await tx<{ visible: boolean }[]>`
                select pg_temp.chat_visible_0144(${FILLER_ORG}, ${actorId}, ${filler.roomId}, now())
                  as visible
              `
            : await tx<{ visible: boolean }[]>`
                select helix_chat_message_visible_to(${FILLER_ORG}, ${actorId}, ${filler.roomId}, now())
                  as visible
              `;
        const after = await counters();
        return {
          visible: result?.visible,
          permissions: after.permissions - before.permissions,
          settings: after.settings - before.settings,
        };
      });

    // An actor with no grant here: the original walks every room's grants.
    const original = await reads("original", actors.member);
    expect(original.visible).toBe(false);
    expect(original.permissions).toBeGreaterThanOrEqual(filler.grants);
    await expect(reads("scoped", actors.member)).resolves.toEqual({
      visible: false,
      permissions: 0,
      settings: 0,
    });
    // A member: exactly the one grant and the one room's settings.
    await expect(reads("scoped", filler.memberId)).resolves.toEqual({
      visible: true,
      permissions: 1,
      settings: 1,
    });
  }, 120_000);
});

async function seedFixtures(sql: postgres.Sql): Promise<void> {
  await sql`
    insert into orgs (id, slug, display_name) values
      (${ORG}, 'chat-visibility-proof', 'Chat visibility proof'),
      (${FOREIGN_ORG}, 'chat-visibility-foreign', 'Chat visibility foreign'),
      (${FILLER_ORG}, 'chat-visibility-filler', 'Chat visibility filler')
  `;
  const people = Object.entries(actors).filter(([name]) => name !== "foreign");
  for (const [name, id] of people) {
    await sql`
      insert into actors (id, org_id, type, email, display_name)
      values (
        ${id}, ${ORG}, ${name === "agent" ? "agent" : "user"},
        ${name === "agent" ? null : `${name}@visibility.test`}, ${name}
      )
    `;
  }
  await sql`
    insert into actors (id, org_id, type, email, display_name)
    values (${actors.foreign}, ${FOREIGN_ORG}, 'user', 'foreign@visibility.test', 'foreign')
  `;

  const chatRooms: readonly (readonly [string, string, object, string])[] = [
    [rooms.full, "chat_room", {}, "restricted"],
    [rooms.sinceJoin, "chat_room", { historyPolicy: "since_join" }, "restricted"],
    [rooms.historyOff, "chat_room", { historyPolicy: "off" }, "restricted"],
    [rooms.retention, "chat_room", { retentionDays: 30 }, "restricted"],
    [rooms.legalHold, "chat_room", { retentionDays: 30, legalHold: true }, "restricted"],
    [rooms.discoverable, "chat_room", {}, "discoverable"],
    [rooms.dm, "chat_dm", { spaceType: "direct" }, "private"],
  ];
  for (const [id, kind, metadata, privacy] of chatRooms) {
    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id)
      values (${id}, ${ORG}, ${kind}::thread_kind, ${id}, ${actors.owner})
    `;
    await sql`
      insert into chat_room_settings (thread_id, org_id, name, metadata, privacy)
      values (${id}, ${ORG}, ${id}, ${sql.json(metadata as postgres.JSONValue)}, ${privacy})
    `;
  }
  await sql`
    insert into threads (id, org_id, kind, subject, created_by_actor_id) values
      (${rooms.noSettings}, ${ORG}, 'chat_room', 'No settings', ${actors.owner}),
      (${rooms.mailThread}, ${ORG}, 'mail', 'Mail thread', ${actors.owner})
  `;
  await sql`
    insert into threads (id, org_id, kind, subject, created_by_actor_id)
    values (${rooms.foreign}, ${FOREIGN_ORG}, 'chat_room', 'Foreign', ${actors.foreign})
  `;
  await sql`
    insert into chat_room_settings (thread_id, org_id, name)
    values (${rooms.foreign}, ${FOREIGN_ORG}, 'Foreign')
  `;

  const grant = (
    actor: string,
    room: string,
    role: string,
    window: { validFromHours?: number; expiresInHours?: number } = {},
  ) => sql`
    insert into permissions (
      org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id,
      valid_from, expires_at
    ) values (
      ${ORG}, ${actor}, 'thread', ${room}, ${role}, ${actors.owner},
      statement_timestamp() + make_interval(hours => ${window.validFromHours ?? -24 * 500}),
      ${window.expiresInHours === undefined ? null : sql`statement_timestamp() + make_interval(hours => ${window.expiresInHours})`}
    )
  `;
  for (const room of [...chatRooms.map(([id]) => id), rooms.noSettings]) {
    await grant(actors.owner, room, "owner");
  }
  for (const room of [rooms.full, rooms.retention, rooms.legalHold, rooms.dm]) {
    await grant(actors.member, room, "member");
  }
  await grant(actors.member, rooms.sinceJoin, "member", { validFromHours: -24 * 5 });
  await grant(actors.member, rooms.mailThread, "member");
  await grant(actors.moderator, rooms.full, "moderator");
  await grant(actors.agent, rooms.full, "member");
  await grant(actors.former, rooms.full, "member");
  await grant(actors.expired, rooms.full, "member", {
    validFromHours: -24 * 10,
    expiresInHours: -24,
  });
  await grant(actors.future, rooms.full, "member", { validFromHours: 24 });
  await grant(actors.disabled, rooms.full, "member");
  await grant(actors.suspended, rooms.full, "member");
  await sql`
    insert into permissions (
      org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
    ) values (${FOREIGN_ORG}, ${actors.foreign}, 'thread', ${rooms.foreign}, 'owner', ${actors.foreign})
  `;

  // Former member: removed the way the product removes one.
  await sql`
    update permissions
    set status = 'revoked', revoked_at = statement_timestamp(), revocation_epoch = 1
    where org_id = ${ORG} and actor_id = ${actors.former} and resource_id = ${rooms.full}
  `;
  await sql`update actors set disabled_at = now() where id = ${actors.disabled}`;
  await sql`
    update organization_memberships
    set status = 'suspended', suspended_at = now()
    where org_id = ${ORG} and actor_id = ${actors.suspended}
  `;

  // Group access is materialized into permission rows by the directory triggers.
  await sql`insert into admin_groups (id, org_id, name) values (${GROUP}, ${ORG}, 'Visibility group')`;
  await sql`
    insert into admin_group_members (org_id, group_id, actor_id)
    values (${ORG}, ${GROUP}, ${actors.grouped})
  `;
  for (const room of [rooms.full, rooms.discoverable]) {
    await sql`
      insert into directory_group_resource_grants (
        org_id, group_id, resource_type, resource_id, role, granted_by_actor_id
      ) values (${ORG}, ${GROUP}, 'thread', ${room}, 'member', ${actors.owner})
    `;
  }
}

/** Enough unrelated grants that a full scan is visibly the wrong plan. */
async function seedFiller(
  sql: postgres.Sql,
): Promise<{ readonly roomId: string; readonly memberId: string; readonly grants: number }> {
  await sql`
    insert into actors (id, org_id, type, display_name)
    select gen_random_uuid(), ${FILLER_ORG}, 'agent', 'filler ' || n
    from generate_series(1, 100) n
  `;
  await sql`
    with founder as (
      select id from actors where org_id = ${FILLER_ORG} order by id limit 1
    )
    insert into threads (id, org_id, kind, subject, created_by_actor_id)
    select gen_random_uuid(), ${FILLER_ORG}, 'chat_room', 'filler ' || n, founder.id
    from generate_series(1, 60) n, founder
  `;
  await sql`
    insert into chat_room_settings (thread_id, org_id, name)
    select id, org_id, subject from threads where org_id = ${FILLER_ORG}
  `;
  await sql`
    with founder as (
      select id from actors where org_id = ${FILLER_ORG} order by id limit 1
    )
    insert into permissions (
      org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
    )
    select ${FILLER_ORG}, actor.id, 'thread', room.id, 'member', founder.id
    from actors actor, threads room, founder
    where actor.org_id = ${FILLER_ORG} and room.org_id = ${FILLER_ORG}
  `;
  await sql`analyze permissions`;
  await sql`analyze chat_room_settings`;
  const [sample] = await sql<{ room_id: string; member_id: string; grants: number }[]>`
    select
      max(resource_id::text) as room_id,
      max(actor_id::text) as member_id,
      count(*)::integer as grants
    from permissions
    where org_id = ${FILLER_ORG}
  `;
  if (sample === undefined) throw new Error("Expected filler grants");
  return { roomId: sample.room_id, memberId: sample.member_id, grants: sample.grants };
}
