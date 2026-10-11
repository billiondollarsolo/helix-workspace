import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { tenantAwarePostgresSql } from "../tenancy/postgres-roles.js";
import { PostgresPeopleStore } from "./people.js";

const live = !skipUnlessLiveDatabase("people directory search");

describe.skipIf(!live)("people directory search (PostgreSQL)", () => {
  const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 1 });
  const sql = tenantAwarePostgresSql(
    postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 2 }),
  );
  const store = new PostgresPeopleStore(sql);
  const orgId = randomUUID();
  const foreignOrgId = randomUUID();
  const viewerId = randomUUID();
  const minaId = randomUUID();
  const hiddenId = randomUUID();
  const disabledId = randomUUID();
  const neighbourId = randomUUID();
  const foreignId = randomUUID();
  const groupId = randomUUID();

  beforeAll(async () => {
    await admin`insert into orgs (id, slug, display_name, status) values
      (${orgId}, ${orgId}, 'People search', 'active'),
      (${foreignOrgId}, ${foreignOrgId}, 'Foreign people', 'active')`;
    await admin`insert into actors (id, org_id, type, email, display_name, metadata, disabled_at) values
      (${viewerId}, ${orgId}, 'user', 'viewer@people.test', 'Viewer', '{}', null),
      (${minaId}, ${orgId}, 'user', 'mina@people.test', 'Mina Park',
        ${admin.json({ profile: { jobTitle: "Product designer" } })}, null),
      (${hiddenId}, ${orgId}, 'user', 'mina.hidden@people.test', 'Mina Hidden',
        ${admin.json({ directoryVisibility: "private" })}, null),
      (${disabledId}, ${orgId}, 'user', 'mina.gone@people.test', 'Mina Gone', '{}', now()),
      (${neighbourId}, ${orgId}, 'user', 'neighbour@people.test', 'Neighbour', '{}', null),
      (${foreignId}, ${foreignOrgId}, 'user', 'mina@foreign.test', 'Mina Foreign', '{}', null)`;
    await admin`insert into admin_groups (id, org_id, name, email, kind) values
      (${groupId}, ${orgId}, 'Mina fan club', 'mina-fans@people.test', 'mailing_list')`;
    await store.importContact({
      orgId,
      actorId: viewerId,
      href: "mina.vcf",
      vcard:
        "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:mina\r\nFN:Mina (personal)\r\nEMAIL:mina@people.test\r\nEND:VCARD\r\n",
    });
    await store.importContact({
      orgId,
      actorId: neighbourId,
      href: "secret.vcf",
      vcard:
        "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:secret\r\nFN:Mina Secret\r\nEMAIL:mina.secret@outside.test\r\nEND:VCARD\r\n",
    });
  });

  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId, foreignOrgId]);
    await admin.end();
    await sql.end();
  });

  it("returns only the actor's tenant, own contacts, and visible members", async () => {
    const people = await store.list({ orgId, actorId: viewerId, query: "mina", limit: 25 });

    expect(people.map((person) => person.email).sort()).toEqual([
      "mina-fans@people.test",
      "mina@people.test",
    ]);
    expect(people.find((person) => person.email === "mina@people.test")).toMatchObject({
      kind: "personal",
      displayName: "Mina (personal)",
      actorId: minaId,
      title: "Product designer",
    });
    expect(people.find((person) => person.kind === "group")).toMatchObject({
      id: groupId,
      actorId: null,
      title: null,
    });
  });

  it("never returns another tenant's people", async () => {
    const people = await store.list({
      orgId: foreignOrgId,
      actorId: foreignId,
      query: "people.test",
      limit: 50,
    });

    expect(people).toEqual([]);
  });

  it("ranks prefix matches ahead of substring matches", async () => {
    const people = await store.list({ orgId, actorId: viewerId, query: "n", limit: 50 });

    expect(people[0]?.displayName).toBe("Neighbour");
  });
});
