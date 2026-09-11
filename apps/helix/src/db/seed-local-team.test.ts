import postgres from "postgres";
import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassword } from "better-auth/crypto";
import type { StorageObject } from "@helix/sdk-types";
import { cleanupTestTenants } from "../test-support/cleanup-tenants.js";
import {
  LOCAL_TEAM_PEOPLE,
  LOCAL_TEAM_SOURCE,
  teamFileFixtures,
  teamId,
  teamPerson,
  LOCAL_TEAM_DIRECT_MESSAGES,
} from "./local-team-fixtures.js";
import { assertLocalTeamTarget, seedLocalTeam } from "./seed-local-team.js";
import { verifyLocalTeam } from "./verify-local-team.js";

it("reserves unique fixture identities, useful files, and local-only targets", () => {
  expect(new Set(LOCAL_TEAM_PEOPLE.map((person) => person.actorId)).size).toBe(10);
  expect(new Set(LOCAL_TEAM_PEOPLE.map((person) => person.email)).size).toBe(10);
  expect(teamFileFixtures()).toHaveLength(34);
  expect(() => {
    assertLocalTeamTarget("postgres://localhost/demo");
  }).not.toThrow();
  expect(() => {
    assertLocalTeamTarget("postgres://production.example/demo");
  }).toThrow("loopback");
});

describe.skipIf(!process.env.DATABASE_URL)("additive team account seed", () => {
  const sql = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const orgId = "f1910000-0000-4000-8000-000000000001";
  beforeAll(async () => {
    await cleanupTestTenants(sql, [orgId]);
    await sql`insert into orgs (id, slug, display_name) values (${orgId}, 'team-seed-test', 'Team seed test')`;
    await sql`insert into actors (id, org_id, type, email, display_name, metadata)
      values (${teamId(0, 100)}, ${orgId}, 'user', 'existing@team.test', 'Existing person', ${sql.json({ untouched: true })})`;
  });
  afterAll(async () => {
    await cleanupTestTenants(sql, [orgId]);
    await sql`delete from account where "userId" like 'local-team-%'`;
    await sql`delete from "user" where id like 'local-team-%'`;
    await sql.end();
  });
  it("creates real credential memberships and preserves existing identities and edits on rerun", async () => {
    const result = await seedLocalTeam(sql, { orgId, accountsOnly: true });
    expect(result.accounts).toHaveLength(10);
    const domains =
      await sql`select status, identity_enabled, mail_enabled, is_primary from admin_domains where org_id = ${orgId} and domain = 'helix.local'`;
    expect(domains).toEqual([
      { status: "verified", identity_enabled: true, mail_enabled: true, is_primary: true },
    ]);
    const mailboxes =
      await sql`select actor_id from helix_resolve_inbound_mailboxes('demo.theo@helix.local', 'helix.local', 100)`;
    expect(mailboxes).toEqual([{ actor_id: teamPerson(1).actorId }]);
    const person = teamPerson(0);
    const accounts = await sql<
      { password: string }[]
    >`select password from account where "userId" = ${`local-team-${person.actorId}`}`;
    const account = accounts[0];
    const login = result.accounts[0];
    assert(account && login);
    expect(await verifyPassword({ password: login.password, hash: account.password })).toBe(true);
    await sql`update actors set display_name = 'Edited by the user', metadata = metadata || ${sql.json({ profile: { about: "Keep my edits" } })} where id = ${person.actorId}`;
    await seedLocalTeam(sql, {
      orgId,
      accountsOnly: true,
      password: "must-not-reset-existing-password",
    });
    const actors = await sql<
      { display_name: string; source: string; scopes: string[]; about: string }[]
    >`
      select display_name, metadata->>'source' as source, scopes, metadata->'profile'->>'about' as about from actors where id = ${person.actorId}`;
    expect(actors[0]).toMatchObject({
      display_name: "Edited by the user",
      source: LOCAL_TEAM_SOURCE,
      about: "Keep my edits",
    });
    expect(actors[0]?.scopes.some((scope) => scope.startsWith("admin."))).toBe(false);
    const unchanged =
      await sql`select display_name, metadata from actors where id = ${teamId(0, 100)}`;
    expect(unchanged[0]).toEqual({
      display_name: "Existing person",
      metadata: { untouched: true },
    });
    const credentials = await sql<
      { password: string }[]
    >`select password from account where "userId" = ${`local-team-${person.actorId}`}`;
    expect(credentials[0]?.password).toBe(accounts[0]?.password);
    const memberships =
      await sql`select actor_id from organization_memberships where org_id = ${orgId} and actor_id in ${sql(LOCAL_TEAM_PEOPLE.map((entry) => entry.actorId))}`;
    expect(memberships).toHaveLength(10);
  });
  it("persists the full dataset through Drive finalize and retains private boundaries on rerun", async () => {
    const direct = LOCAL_TEAM_DIRECT_MESSAGES[0];
    assert(direct);
    const existingDm = teamId(3, 9000);
    await sql`insert into threads (id, org_id, kind, subject, created_by_actor_id, metadata)
      values (${existingDm}, ${orgId}, 'chat_dm', 'Existing live conversation', ${teamPerson(0).actorId}, ${sql.json({ source: "live-conversation" })})`;
    await sql`insert into chat_room_settings (thread_id, org_id, privacy, participant_key)
      values (${existingDm}, ${orgId}, 'private', ${direct.participantKey})`;
    for (const index of direct.members)
      await sql`insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
      values (${orgId}, ${teamPerson(index).actorId}, 'thread', ${existingDm}, 'member', ${teamPerson(0).actorId})`;
    const blobs = new Map<string, StorageObject>();
    let scans = 0;
    let failUpload = true;
    const storage = {
      put(object: StorageObject) {
        if (failUpload) {
          failUpload = false;
          return Promise.reject(new Error("Interrupted fixture upload"));
        }
        blobs.set(object.key, object);
        return Promise.resolve();
      },
      get(key: string) {
        return Promise.resolve(blobs.get(key) ?? null);
      },
      delete(key: string) {
        blobs.delete(key);
        return Promise.resolve();
      },
    };
    const scanner = {
      kind: "clamav" as const,
      scan() {
        scans += 1;
        return Promise.resolve({ clean: true });
      },
    };
    await expect(
      seedLocalTeam(sql, { orgId, storage, scanner, anchorDate: "2026-09-10" }),
    ).rejects.toThrow("Interrupted fixture upload");
    const result = await seedLocalTeam(sql, { orgId, storage, scanner, anchorDate: "2026-09-10" });
    expect(result.files).toHaveLength(34);
    expect(scans).toBe(34);
    const repeated = await seedLocalTeam(sql, {
      orgId,
      storage,
      scanner,
      anchorDate: "2026-09-11",
    });
    expect(repeated.files.map((file) => file.objectId)).toEqual(
      result.files.map((file) => file.objectId),
    );
    expect(scans).toBe(34);
    const counts = await sql`select
      (select count(*)::int from threads where org_id = ${orgId} and kind = 'mail') as mail,
      (select count(*)::int from threads where org_id = ${orgId} and kind = 'chat_room') as rooms,
      (select count(*)::int from threads where org_id = ${orgId} and kind = 'chat_dm') as dms,
      (select count(*)::int from assistant_conversations where org_id = ${orgId}) as conversations,
      (select count(*)::int from cal_events where org_id = ${orgId}) as events,
      (select count(*)::int from objects where org_id = ${orgId} and metadata->>'status' = 'ready' and metadata ? 'avScannedAt') as files`;
    expect(counts[0]).toEqual({
      mail: 20,
      rooms: 5,
      dms: 10,
      conversations: 30,
      events: 30,
      files: 34,
    });
    const privateFile = result.files.find((file) => file.key === "private-decision");
    assert(privateFile);
    const role = async (actorId: string) => {
      const rows = await sql<
        { role: string | null }[]
      >`select helix_drive_effective_role(${orgId}, ${actorId}, 'object', ${privateFile.objectId}) as role`;
      return rows[0]?.role;
    };
    expect(await role(teamPerson(0).actorId)).toBe("owner");
    expect(await role(teamPerson(1).actorId)).toBe("editor");
    expect(await role(teamPerson(9).actorId)).toBeNull();
    expect(await verifyLocalTeam(sql, storage, orgId)).toMatchObject({
      ok: true,
      counts: { drive_files: 34 },
    });
    const firstBlob = [...blobs.entries()][0];
    assert(firstBlob);
    const [key, saved] = firstBlob;
    blobs.delete(key);
    await expect(verifyLocalTeam(sql, storage, orgId)).rejects.toThrow("bytes are missing");
    blobs.set(key, saved);
  }, 30_000);
  it("refuses an occupied fixture identity without overwriting the person", async () => {
    const person = teamPerson(0);
    await sql`update actors set metadata = ${sql.json({ source: "real-person" })} where id = ${person.actorId}`;
    await expect(seedLocalTeam(sql, { orgId, accountsOnly: true })).rejects.toThrow("collide");
    const actor = await sql`select display_name, metadata from actors where id = ${person.actorId}`;
    expect(actor[0]).toEqual({
      display_name: "Edited by the user",
      metadata: { source: "real-person" },
    });
  });
});
