import type { Actor } from "@helix/sdk-types";
import type postgres from "postgres";
import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { PostgresPeopleStore, registerPeopleRoutes, type PeopleStore } from "./people.js";
import { parseVcard } from "./store.js";

describe("People API", () => {
  it("lists the ACL-filtered personal, directory, and group projection", async () => {
    const store = fakeStore();
    store.list.mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000010",
        kind: "personal",
        email: "ada@example.com",
        displayName: "Ada",
        favorite: true,
        avatarDataUrl: null,
        relationship: { manager: "Grace" },
      },
    ]);
    const app = fastify();
    await registerPeopleRoutes(app, { store, actorFromRequest: () => actor() });

    const response = await app.inject({
      method: "GET",
      url: "/api/people?query=ada&favorites=true",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ people: await store.list.mock.results[0]?.value });
    expect(store.list).toHaveBeenCalledWith({
      orgId: "00000000-0000-4000-8000-000000000101",
      actorId: "00000000-0000-4000-8000-000000000001",
      query: "ada",
      favorites: true,
      limit: 25,
    });
  });

  it("imports and exports the same personal vCard identity", async () => {
    const store = fakeStore();
    store.importContact.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000010",
      kind: "personal",
      email: "ada@example.com",
      displayName: "Ada",
      favorite: false,
      avatarDataUrl: null,
      relationship: {},
    });
    store.exportContact.mockResolvedValue("BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Ada\r\nEND:VCARD\r\n");
    const app = fastify();
    await registerPeopleRoutes(app, { store, actorFromRequest: () => actor() });

    const imported = await app.inject({
      method: "POST",
      url: "/api/people/contacts/import",
      payload: { vcard: "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Ada\r\nEND:VCARD\r\n" },
    });
    const exported = await app.inject({
      method: "GET",
      url: "/api/people/contacts/00000000-0000-4000-8000-000000000010/export",
    });

    expect(imported.statusCode).toBe(201);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("text/vcard");
    expect(exported.body).toContain("FN:Ada");
  });

  it("projects bounded favorites, avatars, and relationships from standard vCards", () => {
    const parsed = parseVcard(
      "ada.vcf",
      [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "UID:ada",
        "FN:Ada",
        "EMAIL:ada@example.com",
        "PHOTO:data:image/png;base64,YQ==",
        "RELATED;TYPE=manager:Grace",
        "X-HELIX-FAVORITE:true",
        "END:VCARD",
      ].join("\r\n"),
    );

    expect(parsed).toMatchObject({
      uid: "ada",
      favorite: true,
      avatarDataUrl: "data:image/png;base64,YQ==",
      relationship: { manager: "Grace" },
    });
  });

  it("sets tenant context and filters private, suspended, and duplicate directory entries", async () => {
    const queries: string[] = [];
    const sql = recordingSql(queries, [
      {
        id: "00000000-0000-4000-8000-000000000010",
        kind: "personal",
        email: "ada@example.com",
        display_name: "Ada",
        favorite: true,
        avatar_data_url: null,
        relationship: {},
      },
    ]);
    const store = new PostgresPeopleStore(sql);

    await expect(
      store.list({
        orgId: "00000000-0000-4000-8000-000000000101",
        actorId: "00000000-0000-4000-8000-000000000001",
        query: "ada",
        limit: 25,
      }),
    ).resolves.toHaveLength(1);

    expect(queries.slice(0, 2).join(" ")).toContain("set_config('helix.org_id'");
    const directoryQuery = queries.at(-1) ?? "";
    expect(directoryQuery).toContain("actor.disabled_at is null");
    expect(directoryQuery).toContain("directoryVisibility");
    expect(directoryQuery).toContain("membership.status = 'active'");
    expect(directoryQuery).toContain("row_number() over");
    expect(directoryQuery).toContain("from carddav_contacts");
    expect(directoryQuery).toContain("from admin_groups");
  });
});

function fakeStore() {
  return {
    list: vi.fn<PeopleStore["list"]>().mockResolvedValue([]),
    importContact: vi.fn<PeopleStore["importContact"]>(),
    exportContact: vi.fn<PeopleStore["exportContact"]>(),
    updateContact: vi.fn<PeopleStore["updateContact"]>(),
    deleteContact: vi.fn<PeopleStore["deleteContact"]>(),
    mergeContacts: vi.fn<PeopleStore["mergeContacts"]>(),
  };
}

function actor(): Actor {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000101",
    type: "user",
    displayName: "Owner",
    scopes: [],
  };
}

function recordingSql(queries: string[], result: readonly unknown[]): postgres.Sql {
  const tag = (strings: TemplateStringsArray) => {
    const query = strings.join("$");
    queries.push(query);
    return Promise.resolve(query.includes("with candidates") ? result : []);
  };
  return Object.assign(tag, {
    begin: (work: (tx: postgres.TransactionSql) => Promise<unknown>) => work(tag as never),
    json: (value: unknown) => value,
  }) as postgres.Sql;
}
