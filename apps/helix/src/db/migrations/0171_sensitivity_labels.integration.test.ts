import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.skipIf(process.env.DATABASE_URL === undefined)("sensitivity-label policy effects", () => {
  const sql = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const org = "f1710000-0000-4000-8000-000000000001";
  const owner = "f1710000-0000-4000-8000-000000000011";
  const root = "f1710000-0000-4000-8000-000000000021";
  const child = "f1710000-0000-4000-8000-000000000022";
  const object = "f1710000-0000-4000-8000-000000000031";
  const recording = "f1710000-0000-4000-8000-000000000032";
  const thread = "f1710000-0000-4000-8000-000000000041";
  const room = "f1710000-0000-4000-8000-000000000051";

  async function cleanup(): Promise<void> {
    await sql.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      for (const table of [
        "meet_recording_governance",
        "meet_rooms",
        "messages",
        "threads",
        "resource_classifications",
        "activity",
        "objects",
        "drive_folders",
        "organization_memberships",
        "actors",
      ]) {
        await tx.unsafe(`delete from ${table} where org_id = $1`, [org]);
      }
      await tx`delete from orgs where id = ${org}`;
    });
  }

  beforeAll(async () => {
    const ready = await sql<{ readonly ready: boolean }[]>`
      select to_regclass('sensitivity_labels') is not null as ready
    `;
    if (ready[0]?.ready !== true) throw new Error("Run migration 0171 before this test.");
    await cleanup();
    await sql`insert into orgs(id, slug, display_name) values (${org}, 'labels-171', 'Labels')`;
    await sql`insert into actors(id, org_id, type, email, display_name, scopes)
      values (${owner}, ${org}, 'user', 'owner@labels.test', 'Owner', array['admin.security'])`;
    await sql`insert into drive_folders(
      id, org_id, name, parent_folder_id, owner_actor_id, created_by_actor_id
    ) values
      (${root}, ${org}, 'Root', null, ${owner}, ${owner}),
      (${child}, ${org}, 'Child', ${root}, ${owner}, ${owner})`;
    await sql`insert into objects(
      id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, metadata
    ) values (
      ${object}, ${org}, ${owner}, 'file', 'labels/file', 'text/plain', 1,
      ${sql.json({ name: "file.txt", folderId: child, status: "ready" })}
    )`;
    await sql`insert into threads(id, org_id, kind, subject, created_by_actor_id)
      values (${thread}, ${org}, 'call', 'Labelled call', ${owner})`;
    await sql`insert into meet_rooms(
      id, org_id, thread_id, room_name, join_code, subject, jitsi_domain,
      created_by_actor_id, host_actor_id
    ) values (
      ${room}, ${org}, ${thread}, 'labels-room', 'abcd-efgh-ijkl', 'Labelled call',
      'meet.labels.test', ${owner}, ${owner}
    )`;
    await sql`insert into objects(
      id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, metadata
    ) values (
      ${recording}, ${org}, ${owner}, 'recording', 'labels/recording', 'video/mp4', 1,
      ${sql.json({ name: "recording.mp4", status: "ready" })}
    )`;
    await sql`insert into meet_recording_governance(
      org_id, object_id, room_id, thread_id, owner_actor_id, classification, region
    ) values (${org}, ${recording}, ${room}, ${thread}, ${owner}, 'standard', 'default')`;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  it("inherits labels, projects policy/export metadata, audits, and rejects unauthorized downgrade", async () => {
    await sql`update resource_classifications set
      classification = 'confidential', source = 'explicit', reason = 'project policy',
      actor_id = ${owner}, updated_at = statement_timestamp()
      where org_id = ${org} and resource_type = 'drive.folder' and resource_id = ${root}`;

    const projected = await sql<
      {
        readonly classification: string;
        readonly source: string;
        readonly marking: string;
        readonly encryption: string;
        readonly retained: boolean;
      }[]
    >`
      select classification.classification, classification.source,
        object.metadata->'sensitivityLabel'->>'marking' as marking,
        object.metadata->'sensitivityLabel'->>'encryption' as encryption,
        object.retain_until > statement_timestamp() + interval '364 days' as retained
      from resource_classifications classification join objects object
        on object.org_id = classification.org_id and object.id::text = classification.resource_id
      where classification.org_id = ${org} and classification.resource_type = 'drive.file'
        and classification.resource_id = ${object}
    `;
    expect(projected[0]).toMatchObject({
      classification: "confidential",
      source: "folder",
      marking: "CONFIDENTIAL",
      encryption: "tenant_kms",
      retained: true,
    });
    const audit = await sql<{ readonly count: number }[]>`
      select count(*)::integer as count from activity
      where org_id = ${org} and verb = 'sensitivity.label.changed'
    `;
    expect(audit[0]?.count).toBeGreaterThanOrEqual(3);

    await expect(
      sql`update resource_classifications set classification = 'public', source = 'explicit'
        where org_id = ${org} and resource_type = 'drive.folder' and resource_id = ${root}`,
    ).rejects.toThrow(/security-administrator permission/u);

    await sql.begin(async (tx) => {
      await tx`select set_config('helix.allow_sensitivity_downgrade', 'on', true)`;
      await tx`update resource_classifications set classification = 'public', source = 'explicit'
        where org_id = ${org} and resource_type = 'drive.folder' and resource_id = ${root}`;
    });
    const lowered = await sql<{ readonly classification: string }[]>`
      select classification from resource_classifications
      where org_id = ${org} and resource_type = 'drive.file' and resource_id = ${object}
    `;
    expect(lowered[0]?.classification).toBe("public");
  });

  it("turns a confidential recording into retained, non-exportable evidence", async () => {
    await sql`update resource_classifications set
      classification = 'confidential', source = 'explicit', reason = 'recording policy',
      actor_id = ${owner}, updated_at = statement_timestamp()
      where org_id = ${org} and resource_type = 'drive.file' and resource_id = ${recording}`;
    const governed = await sql<
      {
        readonly classification: string;
        readonly export_allowed: boolean;
        readonly retained: boolean;
      }[]
    >`
      select classification, export_allowed,
        retention_until > statement_timestamp() + interval '364 days' as retained
      from meet_recording_governance
      where org_id = ${org} and object_id = ${recording}
    `;
    expect(governed[0]).toEqual({
      classification: "confidential",
      export_allowed: false,
      retained: true,
    });
  });
});
