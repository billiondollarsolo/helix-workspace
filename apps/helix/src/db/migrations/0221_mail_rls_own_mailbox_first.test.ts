import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";

const ORG = "f2210000-0000-4000-8000-000000000001";
const FOREIGN_ORG = "f2210000-0000-4000-8000-000000000002";

const actors = {
  sender: "f2210000-0000-4000-8000-000000000101",
  recipient: "f2210000-0000-4000-8000-000000000102",
  delegate: "f2210000-0000-4000-8000-000000000103",
  expiredDelegate: "f2210000-0000-4000-8000-000000000104",
  disabledDelegate: "f2210000-0000-4000-8000-000000000105",
  disabledMailbox: "f2210000-0000-4000-8000-000000000106",
  service: "f2210000-0000-4000-8000-000000000107",
  disabledService: "f2210000-0000-4000-8000-000000000108",
  outsider: "f2210000-0000-4000-8000-000000000109",
  foreign: "f2210000-0000-4000-8000-000000000201",
} as const;

const threads = {
  shared: "f2210000-0000-4000-8000-000000000301",
  senderOnly: "f2210000-0000-4000-8000-000000000302",
  disabledOnly: "f2210000-0000-4000-8000-000000000303",
  orphan: "f2210000-0000-4000-8000-000000000304",
  team: "f2210000-0000-4000-8000-000000000305",
  foreign: "f2210000-0000-4000-8000-000000000401",
} as const;

/** One mail message per thread, plus an ID that names no message. */
const messages = {
  ...Object.fromEntries(
    Object.entries(threads).map(([name, id]) => [name, id.replace(/0{3}(\d{3})$/u, "001$1")]),
  ),
  missing: "f2210000-0000-4000-8000-000000000999",
} as Record<string, string>;

const TEAM_SIZE = 40;

/** A predicate exactly as an earlier migration defined it, renamed into pg_temp. */
function originalDefinition(file: string, name: string, renames: Record<string, string>): string {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const start = source.indexOf(`create or replace function ${name}(`);
  const end = source.indexOf("$$;", start) + "$$;".length;
  if (start < 0 || end <= start) throw new Error(`${name} not found in ${file}`);
  return Object.entries(renames).reduce(
    (definition, [from, to]) => definition.replaceAll(from, to),
    source.slice(start, end),
  );
}

const oracleRenames = {
  "function helix_can_access_mailbox(": "function pg_temp.access_original(",
  "function helix_can_read_mail_thread(": "function pg_temp.thread_original(",
  "function helix_can_read_mail_message(": "function pg_temp.message_original(",
  "public.helix_can_access_mailbox(": "pg_temp.access_original(",
  "public.helix_can_read_mail_thread(": "pg_temp.thread_original(",
};

interface MatrixRow {
  readonly predicate: string;
  readonly org: string;
  readonly target: string;
  readonly original: boolean | null;
  readonly rewritten: boolean | null;
}

const skip = skipUnlessLiveDatabase("0221 mail RLS own mailbox first");

describe("0221 mail RLS own mailbox first", { skip }, () => {
  // One connection: the oracles are temporary functions on this session.
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL ?? "", { max: 1, prepare: false, onnotice: () => {} });
    await cleanupTestTenants(sql, [ORG, FOREIGN_ORG]);
    await sql.unsafe(
      originalDefinition("./0108_mailbox_actor_rls.sql", "helix_can_access_mailbox", oracleRenames),
    );
    await sql.unsafe(
      originalDefinition(
        "./0108_mailbox_actor_rls.sql",
        "helix_can_read_mail_thread",
        oracleRenames,
      ),
    );
    await sql.unsafe(
      originalDefinition(
        "./0135_mail_trash_retention.sql",
        "helix_can_read_mail_message",
        oracleRenames,
      ),
    );
    await seedFixtures(sql);
  }, 60_000);

  afterAll(async () => {
    await cleanupTestTenants(sql, [ORG, FOREIGN_ORG]);
    await sql.end();
  }, 60_000);

  it("returns exactly the original result for every caller, tenant and target", async () => {
    const callers = [...Object.values(actors), ""];
    const contexts = [ORG, FOREIGN_ORG, ""].flatMap((org) =>
      callers.map((actor) => ({ org, actor })),
    );
    const differences: (MatrixRow & { readonly context: string })[] = [];
    const granted = new Set<string>();
    for (const context of contexts) {
      const rows = await sql.begin(async (tx) => {
        await tx`
          select set_config('helix.org_id', ${context.org}, true),
                 set_config('helix.actor_id', ${context.actor}, true)
        `;
        return tx<MatrixRow[]>`
          select 'access' as predicate, org.id::text as org, target.id::text as target,
                 pg_temp.access_original(org.id, target.id) as original,
                 helix_can_access_mailbox(org.id, target.id) as rewritten
          from unnest(${[ORG, FOREIGN_ORG]}::uuid[]) org(id)
          cross join unnest(${Object.values(actors)}::uuid[]) target(id)
          union all
          select 'thread', org.id::text, target.id::text,
                 pg_temp.thread_original(org.id, target.id),
                 helix_can_read_mail_thread(org.id, target.id)
          from unnest(${[ORG, FOREIGN_ORG]}::uuid[]) org(id)
          cross join unnest(${Object.values(threads)}::uuid[]) target(id)
          union all
          select 'message', org.id::text, target.id::text,
                 pg_temp.message_original(org.id, target.id),
                 helix_can_read_mail_message(org.id, target.id)
          from unnest(${[ORG, FOREIGN_ORG]}::uuid[]) org(id)
          cross join unnest(${Object.values(messages)}::uuid[]) target(id)
        `;
      });
      for (const row of rows) {
        if (row.original !== row.rewritten) {
          differences.push({ ...row, context: `${context.org}/${context.actor}` });
        }
        if (row.rewritten === true) {
          granted.add(`${context.org}|${context.actor}|${row.predicate}|${row.org}|${row.target}`);
        }
      }
    }
    expect(differences).toEqual([]);

    // The matrix exercises both outcomes of every rule, not one constant answer.
    const reads = (actor: string, predicate: string, target: string, org: string = ORG) =>
      granted.has(`${org}|${actor}|${predicate}|${org}|${target}`);
    expect(reads(actors.recipient, "access", actors.recipient)).toBe(true);
    expect(reads(actors.recipient, "thread", threads.shared)).toBe(true);
    expect(reads(actors.recipient, "message", messages.shared ?? "")).toBe(true);
    expect(reads(actors.recipient, "thread", threads.senderOnly)).toBe(false);
    expect(reads(actors.delegate, "access", actors.recipient)).toBe(true);
    expect(reads(actors.delegate, "thread", threads.shared)).toBe(true);
    expect(reads(actors.delegate, "thread", threads.senderOnly)).toBe(false);
    expect(reads(actors.expiredDelegate, "thread", threads.shared)).toBe(false);
    expect(reads(actors.disabledDelegate, "access", actors.recipient)).toBe(false);
    expect(reads(actors.disabledMailbox, "thread", threads.disabledOnly)).toBe(false);
    expect(reads(actors.service, "thread", threads.disabledOnly)).toBe(true);
    expect(reads(actors.service, "message", messages.orphan ?? "")).toBe(true);
    expect(reads(actors.disabledService, "thread", threads.shared)).toBe(false);
    expect(reads(actors.outsider, "message", messages.shared ?? "")).toBe(false);
    expect(reads("", "thread", threads.orphan)).toBe(true);
    expect(reads(actors.sender, "message", messages.missing ?? "")).toBe(false);
    expect(reads(actors.foreign, "thread", threads.foreign, FOREIGN_ORG)).toBe(true);
    expect(granted.has(`${ORG}|${actors.foreign}|thread|${FOREIGN_ORG}|${threads.foreign}`)).toBe(
      false,
    );
    expect(reads(actors.sender, "thread", threads.team)).toBe(true);
  }, 120_000);

  it("reads only the caller's own mailbox row for a thread shared with a whole team", async () => {
    const mailboxRowsRead = (predicate: "thread" | "message", actorId: string) =>
      sql.begin(async (tx) => {
        await tx`
          select set_config('helix.org_id', ${ORG}, true),
                 set_config('helix.actor_id', ${actorId}, true)
        `;
        // Rows read by sequential and index scans. The session's counters also
        // hold earlier unflushed transactions, so measure a delta around the call.
        const counter = async () => {
          const [row] = await tx<{ rows: string }[]>`
            select (coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0))::text as rows
            from pg_stat_xact_user_tables
            where relid = 'public.mail_thread_state'::regclass
          `;
          return Number(row?.rows ?? 0);
        };
        const before = await counter();
        const [result] =
          predicate === "thread"
            ? await tx<{ visible: boolean }[]>`
                select helix_can_read_mail_thread(${ORG}, ${threads.team}) as visible
              `
            : await tx<{ visible: boolean }[]>`
                select helix_can_read_mail_message(${ORG}, ${messages.team ?? ""}) as visible
              `;
        return { visible: result?.visible, rows: (await counter()) - before };
      });

    // The last member to receive the thread: an unordered probe meets every
    // other member's row first.
    await expect(mailboxRowsRead("thread", actors.recipient)).resolves.toEqual({
      visible: true,
      rows: 1,
    });
    await expect(mailboxRowsRead("message", actors.recipient)).resolves.toEqual({
      visible: true,
      rows: 1,
    });
  }, 60_000);
});

async function seedFixtures(sql: postgres.Sql): Promise<void> {
  await sql`
    insert into orgs (id, slug, display_name) values
      (${ORG}, 'mail-rls-own-mailbox', 'Mail RLS own mailbox'),
      (${FOREIGN_ORG}, 'mail-rls-own-mailbox-foreign', 'Mail RLS own mailbox foreign')
  `;
  for (const [name, id] of Object.entries(actors)) {
    const service = name === "service" || name === "disabledService";
    await sql`
      insert into actors (id, org_id, type, email, display_name)
      values (
        ${id}, ${name === "foreign" ? FOREIGN_ORG : ORG},
        ${service ? "service_account" : "user"},
        ${service ? null : `${name}@own-mailbox.test`}, ${name}
      )
    `;
  }
  await sql`
    insert into actors (id, org_id, type, email, display_name)
    select gen_random_uuid(), ${ORG}, 'user', 'team' || n || '@own-mailbox.test', 'team ' || n
    from generate_series(1, ${TEAM_SIZE}) n
  `;

  for (const [name, id] of Object.entries(threads)) {
    const org = name === "foreign" ? FOREIGN_ORG : ORG;
    const author = name === "foreign" ? actors.foreign : actors.sender;
    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id)
      values (${id}, ${org}, 'mail', ${name}, ${author})
    `;
    await sql`
      insert into messages (id, org_id, thread_id, actor_id, kind, body, metadata)
      values (
        ${messages[name] ?? ""}, ${org}, ${id}, ${author}, 'mail', ${name},
        ${sql.json({ direction: "outbound", subject: name, from: { address: "sender@own-mailbox.test" } })}
      )
    `;
  }

  const mailbox = (actorId: string, threadId: string, org: string = ORG) => sql`
    insert into mail_thread_state (org_id, actor_id, thread_id) values (${org}, ${actorId}, ${threadId})
  `;
  await mailbox(actors.sender, threads.shared);
  await mailbox(actors.recipient, threads.shared);
  await mailbox(actors.disabledMailbox, threads.shared);
  await mailbox(actors.sender, threads.senderOnly);
  await mailbox(actors.disabledMailbox, threads.disabledOnly);
  await mailbox(actors.foreign, threads.foreign, FOREIGN_ORG);
  await mailbox(actors.sender, threads.team);
  await sql`
    insert into mail_thread_state (org_id, actor_id, thread_id)
    select ${ORG}, id, ${threads.team} from actors
    where org_id = ${ORG} and email like 'team%@own-mailbox.test'
  `;
  await mailbox(actors.recipient, threads.team);

  const manager = (delegate: string, expiresInHours?: number) => sql`
    insert into permissions (
      org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id,
      valid_from, expires_at
    ) values (
      ${ORG}, ${delegate}, 'mailbox', ${actors.recipient}, 'manager', ${actors.recipient},
      statement_timestamp() - interval '30 days',
      ${expiresInHours === undefined ? null : sql`statement_timestamp() + make_interval(hours => ${expiresInHours})`}
    )
  `;
  await manager(actors.delegate);
  await manager(actors.expiredDelegate, -1);
  await manager(actors.disabledDelegate);
  await sql`
    update actors set disabled_at = now()
    where id in (${actors.disabledDelegate}, ${actors.disabledMailbox}, ${actors.disabledService})
  `;
  await sql`analyze mail_thread_state`;
}
