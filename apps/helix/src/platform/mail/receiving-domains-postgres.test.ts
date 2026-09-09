import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skipUnlessLiveDatabase } from "../test/live-suite.js";
import {
  PostgresReceivingDomainStore,
  ReceivingDomainCatchAllError,
} from "./receiving-domains-store.js";

const live = describe.skipIf(skipUnlessLiveDatabase("mail receiving domains (live PostgreSQL)"));

live("PostgresReceivingDomainStore", () => {
  const orgOne = "f7510000-0000-4000-8000-000000000001";
  const orgTwo = "f7510000-0000-4000-8000-000000000002";
  const actorOne = "f7510000-0000-4000-8000-000000000011";
  const actorTwo = "f7510000-0000-4000-8000-000000000022";
  const aliasId = "f7510000-0000-4000-8000-000000000031";
  let sql: postgres.Sql;
  let store: PostgresReceivingDomainStore;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL ?? "", { max: 4, prepare: false });
    store = new PostgresReceivingDomainStore(sql);
    await sql`
      insert into orgs (id, slug, display_name)
      values
        (${orgOne}, 'm1-store-test-one', 'M1 store test one'),
        (${orgTwo}, 'm1-store-test-two', 'M1 store test two')
      on conflict (id) do nothing
    `;
    await sql`
      insert into actors (id, org_id, type, email, display_name, scopes)
      values
        (${actorOne}, ${orgOne}, 'user', 'Owner@store.example', 'M1 owner one', '{}'),
        (${actorTwo}, ${orgTwo}, 'user', 'other@other.example', 'M1 owner two', '{}')
      on conflict (id) do nothing
    `;
    await sql`
      insert into mail_aliases (id, org_id, actor_id, email, display_name)
      values (${aliasId}, ${orgOne}, ${actorOne}, 'support@store.example', 'Support')
      on conflict (id) do nothing
    `;
  });

  afterAll(async () => {
    await sql`delete from mail_receiving_domains where org_id in (${orgOne}, ${orgTwo})`;
    await sql`delete from mail_aliases where id = ${aliasId}`;
    await sql`delete from actors where id in (${actorOne}, ${actorTwo})`;
    await sql`delete from orgs where id in (${orgOne}, ${orgTwo})`;
    await sql.end();
  });

  it("persists the verified lifecycle and resolves primary, alias, and catch-all mailboxes", async () => {
    const domain = await store.createDomain({
      orgId: orgOne,
      domain: "STORE.example",
      catchAllActorId: actorOne,
      createdBy: actorOne,
    });
    expect(domain).toMatchObject({ domain: "store.example", status: "pending" });
    await expect(store.resolveReceivingDomain("store.example")).resolves.toBeNull();

    await store.markVerified(orgOne, domain.id);
    await store.enableDomain(orgOne, domain.id);
    await expect(store.resolveReceivingDomain("STORE.example")).resolves.toMatchObject({
      id: domain.id,
      orgId: orgOne,
      status: "active",
    });
    await expect(store.resolveMailbox("OWNER@store.example")).resolves.toMatchObject({
      actorId: actorOne,
      match: "primary",
    });
    await expect(store.resolveMailbox("support@store.example")).resolves.toMatchObject({
      actorId: actorOne,
      match: "alias",
    });
    await expect(store.resolveMailbox("unknown@store.example")).resolves.toMatchObject({
      actorId: actorOne,
      match: "catch_all",
    });

    await store.disableDomain(orgOne, domain.id);
    await expect(store.resolveReceivingDomain("store.example")).resolves.toBeNull();
    await expect(store.resolveMailbox("owner@store.example")).resolves.toBeNull();
  });

  it("rejects a cross-organization catch-all before persistence", async () => {
    await expect(
      store.createDomain({
        orgId: orgOne,
        domain: "invalid-catch-all.example",
        catchAllActorId: actorTwo,
        createdBy: actorOne,
      }),
    ).rejects.toBeInstanceOf(ReceivingDomainCatchAllError);
  });
});
