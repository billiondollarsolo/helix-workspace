import type { Actor } from "@helix/sdk-types";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { parseActorRoleBindings } from "../permissions/roles.js";
import { tenantAwarePostgresSql } from "../tenancy/postgres-roles.js";
import { createToolRegistry } from "../tool-registry.js";
import { PostgresContactsStore } from "./contacts-store.js";
import { registerContactsTools } from "./contacts-tools.js";
import { PostgresCardDavContactStore } from "./store.js";

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const skip = skipUnlessLiveDatabase("Contacts tools through the runtime role");

const SCOPES = ["contacts.read", "contacts.write"];

describe.skipIf(skip)("contacts tools", () => {
  const admin = postgres(adminUrl ?? "", { max: 1 });
  const app = tenantAwarePostgresSql(postgres(appUrl ?? "", { max: 2 }));
  const registry = createToolRegistry();
  registerContactsTools(registry, { store: new PostgresContactsStore(app) });
  const cardDav = new PostgresCardDavContactStore(app);
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const hidden = randomUUID();
  const mallory = randomUUID();

  const actor = (id: string, org = orgId, scopes = SCOPES): Actor => ({
    id,
    orgId: org,
    type: "user",
    displayName: "Member",
    scopes,
  });

  async function call<T>(toolId: string, input: unknown, as: Actor = actor(alice)): Promise<T> {
    const result = await registry.invoke(toolId, input, { actor: as });
    if (!result.ok) throw new Error(`${toolId} failed: ${JSON.stringify(result)}`);
    return result.output as T;
  }

  beforeAll(async () => {
    if (adminUrl === undefined || appUrl === undefined)
      throw new Error("Contacts tests require migration and app database URLs.");
    await admin`insert into orgs (id, slug, display_name) values
      (${orgId}, ${orgId}, 'Contacts'), (${otherOrgId}, ${otherOrgId}, 'Other contacts')`;
    await admin`insert into actors (id, org_id, type, email, display_name, metadata) values
      (${alice}, ${orgId}, 'user', ${`alice-${orgId}@example.test`}, 'Alice', '{}'),
      (${bob}, ${orgId}, 'user', ${`bob-${orgId}@example.test`}, 'Bob Builder',
        ${admin.json({ profile: { jobTitle: "Engineer" } })}),
      (${hidden}, ${orgId}, 'user', ${`hidden-${orgId}@example.test`}, 'Hidden',
        ${admin.json({ directoryVisibility: "private" })}),
      (${mallory}, ${otherOrgId}, 'user', ${`mallory-${otherOrgId}@example.test`}, 'Mallory', '{}')`;
  });
  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId, otherOrgId]);
    await Promise.all([admin.end(), app.end()]);
  });

  it("creates, reads and edits a contact that CardDAV clients see", async () => {
    const { contact } = await call<{
      contact: { id: string; displayName: string; memberActorId: string | null };
    }>("contacts.create", {
      givenName: "Bob",
      familyName: "Builder",
      company: "Acme",
      emails: [{ type: "work", value: `BOB-${orgId}@example.test` }],
      phones: [{ type: "mobile", value: "+1 555 0100" }],
      birthday: "--04-01",
      labels: ["Team"],
    });
    expect(contact).toMatchObject({ displayName: "Bob Builder", memberActorId: bob });

    const updated = await call<{
      contact: { jobTitle: string; labels: string[]; phones: unknown[] };
    }>("contacts.update", { id: contact.id, jobTitle: "Foreman", labels: ["Team", "Site"] });
    expect(updated.contact).toMatchObject({
      jobTitle: "Foreman",
      labels: ["Team", "Site"],
      phones: [{ type: "mobile", value: "+1 555 0100" }],
    });

    const synced = await cardDav.listContactsForActor({ orgId, actorId: alice, limit: 10 });
    expect(synced).toHaveLength(1);
    expect(synced[0]?.vcard).toContain("TITLE:Foreman");
    expect(synced[0]?.vcard).toContain("CATEGORIES:Team,Site");
    const activity = await admin<{ verb: string }[]>`
      select verb from activity where org_id = ${orgId} and object_id = ${contact.id} order by id
    `;
    expect(activity.map((row) => row.verb).sort()).toEqual([
      "carddav.contact.created",
      "carddav.contact.updated",
    ]);
  });

  it("keeps each member's contacts private and tenants apart", async () => {
    const own = await call<{ contacts: { id: string }[]; total: number }>("contacts.list", {});
    expect(own.total).toBe(1);
    const id = own.contacts[0]?.id ?? "";

    expect(await call("contacts.list", {}, actor(bob))).toEqual({ contacts: [], total: 0 });
    for (const [toolId, input] of [
      ["contacts.get", { id }],
      ["contacts.update", { id, jobTitle: "Intruder" }],
    ] as const) {
      expect(await registry.invoke(toolId, input, { actor: actor(bob) })).toMatchObject({
        ok: false,
        statusCode: 404,
      });
      expect(
        await registry.invoke(toolId, input, { actor: actor(mallory, otherOrgId) }),
      ).toMatchObject({ ok: false, statusCode: 404 });
    }
    expect(await call("contacts.trash", { ids: [id] }, actor(bob))).toEqual({ ids: [] });
    expect(await call("contacts.export", {}, actor(mallory, otherOrgId))).toMatchObject({
      count: 0,
    });
    expect(await call("contacts.labels.list", {}, actor(bob))).toEqual({ labels: [], total: 0 });
  });

  it("requires the contacts scopes", async () => {
    expect(
      await registry.invoke(
        "contacts.list",
        {},
        { actor: actor(alice, orgId, ["contacts.write"]) },
      ),
    ).toMatchObject({ ok: false, statusCode: 403 });
    expect(
      await registry.invoke(
        "contacts.create",
        { givenName: "Nope" },
        { actor: actor(alice, orgId, ["contacts.read"]) },
      ),
    ).toMatchObject({ ok: false, statusCode: 403 });
  });

  it("creates, renames and deletes labels on the cards that carry them", async () => {
    await call("contacts.label.create", { name: "Empty" });
    expect(
      await registry.invoke("contacts.label.create", { name: "team" }, { actor: actor(alice) }),
    ).toMatchObject({ ok: false, statusCode: 409 });
    expect((await call<{ labels: unknown[] }>("contacts.labels.list", {})).labels).toEqual([
      { name: "Empty", count: 0 },
      { name: "Site", count: 1 },
      { name: "Team", count: 1 },
    ]);

    await call("contacts.label.rename", { name: "Team", newName: "Crew" });
    await call("contacts.label.delete", { name: "Site" });
    const { contacts } = await call<{ contacts: { labels: string[] }[] }>("contacts.list", {
      label: "crew",
    });
    expect(contacts.map((contact) => contact.labels)).toEqual([["Crew"]]);
    expect((await call<{ labels: unknown[] }>("contacts.labels.list", {})).labels).toEqual([
      { name: "Crew", count: 1 },
      { name: "Empty", count: 0 },
    ]);
  });

  it("imports, finds duplicates, merges and exports", async () => {
    const vcf = [
      "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:dup-1\r\nFN:Robert Builder\r\nTEL:+1 (555) 0100\r\nEMAIL:rob@example.test\r\nEND:VCARD",
      "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:solo\r\nFN:Solo\r\nEMAIL:solo@example.test\r\nEND:VCARD",
      "BEGIN:VCARD\r\nVERSION:2.1\r\nFN:Old\r\nEND:VCARD",
    ].join("\r\n");
    expect(await call("contacts.import", { format: "vcard", content: vcf, dryRun: true })).toEqual({
      count: 2,
      skipped: 1,
      problems: ["Card 3: it is not a valid vCard 3.0 or 4.0 card."],
      sample: ["Robert Builder", "Solo"],
      imported: false,
    });
    expect((await call<{ total: number }>("contacts.list", {})).total).toBe(1);
    expect(
      await call("contacts.import", { format: "vcard", content: vcf, label: "Imported" }),
    ).toMatchObject({ count: 2, imported: true });
    // Re-importing the same cards updates them (keeping their labels) instead of duplicating.
    await call("contacts.import", { format: "vcard", content: vcf });
    expect((await call<{ total: number }>("contacts.list", {})).total).toBe(3);

    const { groups } = await call<{
      groups: { reason: string; contacts: { id: string; displayName: string }[] }[];
    }>("contacts.duplicates.list", {});
    expect(groups).toHaveLength(1);
    expect(groups[0]?.reason).toBe("phone");
    const [target, source] = groups[0]?.contacts ?? [];
    const merged = await call<{ contact: { emails: unknown[]; labels: string[] } }>(
      "contacts.merge",
      {
        targetId: target?.id,
        sourceIds: [source?.id],
      },
    );
    expect(merged.contact.emails).toHaveLength(2);
    expect((await call<{ total: number }>("contacts.list", {})).total).toBe(2);
    expect((await call<{ groups: unknown[] }>("contacts.duplicates.list", {})).groups).toEqual([]);

    const exported = await call<{ filename: string; vcard: string; count: number }>(
      "contacts.export",
      { label: "Imported" },
    );
    expect(exported).toMatchObject({ filename: "Imported.vcf", count: 2 });
    expect(exported.vcard.match(/BEGIN:VCARD/gu)).toHaveLength(2);
  });

  it("moves contacts to Trash, restores them and deletes them forever", async () => {
    const { contacts } = await call<{ contacts: { id: string }[] }>("contacts.list", {
      query: "solo",
    });
    const id = contacts[0]?.id ?? "";
    expect(await call("contacts.trash", { ids: [id] })).toEqual({ ids: [id] });
    // Contacts merged away do not appear in Trash.
    expect((await call<{ total: number }>("contacts.list", { view: "trash" })).total).toBe(1);
    expect(await call("contacts.restore", { ids: [id] })).toEqual({ ids: [id] });
    await call("contacts.trash", { ids: [id] });

    expect(await call("contacts.purge", { ids: [id] }, actor(bob))).toEqual({ ids: [] });
    expect(await call("contacts.purge", { ids: [id] })).toEqual({ ids: [id] });
    expect(await registry.invoke("contacts.get", { id }, { actor: actor(alice) })).toMatchObject({
      statusCode: 404,
    });
  });

  it("lists visible members of the actor's own organization only", async () => {
    const { members, total } = await call<{
      members: { actorId: string; jobTitle: string | null }[];
      total: number;
    }>("contacts.directory.list", {});
    expect(total).toBe(2);
    expect(members.map((member) => member.actorId).sort()).toEqual([alice, bob].sort());
    expect(members.find((member) => member.actorId === bob)?.jobTitle).toBe("Engineer");
    expect(
      await call<{ members: unknown[] }>("contacts.directory.list", { query: "mallory" }),
    ).toMatchObject({ members: [], total: 0 });
  });

  it("lets every member use Contacts through the built-in member role", async () => {
    // Bob has no direct scopes: his access comes from the member role alone.
    const rows = await admin<{ role_bindings: unknown }[]>`
      select helix_actor_role_bindings(org_id, id) as role_bindings
      from actors where org_id = ${orgId} and id = ${bob}
    `;
    const roleBindings = parseActorRoleBindings(rows[0]?.role_bindings);
    expect(roleBindings.flatMap((binding) => binding.allow)).toEqual(
      expect.arrayContaining(["contacts.read", "contacts.write"]),
    );
    const member: Actor = { ...actor(bob, orgId, []), roleBindings };
    expect(
      await registry.invoke("contacts.create", { givenName: "Via role" }, { actor: member }),
    ).toMatchObject({ ok: true });
    expect(await registry.invoke("contacts.list", {}, { actor: member })).toMatchObject({
      ok: true,
      output: { total: 1 },
    });
  });
});
