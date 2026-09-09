import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL === undefined ? null : postgres(DATABASE_URL, { max: 1 });

describe("0111 composite tenant foreign keys migration", () => {
  it("upgrades every tenant-owned foreign key and guards folder cycles", async () => {
    const migration = await readFile(
      new URL("./0111_composite_tenant_foreign_keys.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("source.org_id is distinct from target.org_id");
    expect(migration).toContain("foreign key (org_id, %s)");
    expect(migration).toContain("foreign key (org_id, %I) references actors (org_id, id)");
    expect(migration).toContain("permissions_require_tenant_resource");
    expect(migration).toContain("drive_folders_no_self_parent");
    expect(migration).toContain("drive_folders_require_acyclic_parent");
    expect(migration).toContain("drive_folders_acyclic");
  });

  it("finishes editor relationships after editor migrations run", async () => {
    const migration = await readFile(
      new URL(
        "../post-editor-migrations/0112_editor_composite_tenant_foreign_keys.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(migration).toContain("foreign key (org_id, document_id)");
    expect(migration).toContain("foreign key (org_id, created_by_actor_id)");
    expect(migration).toContain("references docs_documents (org_id, id)");
    expect(migration).toContain("references actors (org_id, id)");
  });
});

describe.skipIf(sql === null)("0111 live tenant relationship enforcement", () => {
  const database = sql as postgres.Sql;
  const orgA = "8d4f546c-0dd9-44a4-b95c-d41bf8269301";
  const orgB = "8d4f546c-0dd9-44a4-b95c-d41bf8269302";
  const actorA = "8d4f546c-0dd9-44a4-b95c-d41bf8269311";
  const actorB = "8d4f546c-0dd9-44a4-b95c-d41bf8269312";
  const threadB = "8d4f546c-0dd9-44a4-b95c-d41bf8269322";
  const messageB = "8d4f546c-0dd9-44a4-b95c-d41bf8269332";
  const objectB = "8d4f546c-0dd9-44a4-b95c-d41bf8269342";
  const folderA = "8d4f546c-0dd9-44a4-b95c-d41bf8269351";
  const folderB = "8d4f546c-0dd9-44a4-b95c-d41bf8269352";
  const orgUnitA = "8d4f546c-0dd9-44a4-b95c-d41bf8269361";
  const orgUnitB = "8d4f546c-0dd9-44a4-b95c-d41bf8269362";
  const groupA = "8d4f546c-0dd9-44a4-b95c-d41bf8269371";

  beforeAll(async () => {
    await database`
      insert into orgs (id, slug, display_name, status, tier, region)
      values
        (${orgA}, 'iam07-a', 'IAM 07 A', 'active', 'business', 'test'),
        (${orgB}, 'iam07-b', 'IAM 07 B', 'active', 'business', 'test')
      on conflict (id) do nothing
    `;
    await database`
      insert into actors (id, org_id, type, display_name)
      values (${actorA}, ${orgA}, 'user', 'IAM 07 A'), (${actorB}, ${orgB}, 'user', 'IAM 07 B')
      on conflict (id) do nothing
    `;
    await database`
      insert into threads (id, org_id, kind, created_by_actor_id)
      values (${threadB}, ${orgB}, 'chat_room', ${actorB})
      on conflict (id) do nothing
    `;
    await database`
      insert into messages (id, org_id, thread_id, actor_id, kind, body)
      values (${messageB}, ${orgB}, ${threadB}, ${actorB}, 'system', 'IAM 07')
      on conflict (id) do nothing
    `;
    await database`
      insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size)
      values (${objectB}, ${orgB}, ${actorB}, 'file', 'iam07/object', 'text/plain', 1)
      on conflict (id) do nothing
    `;
    await database`
      insert into drive_folders (id, org_id, name, owner_actor_id, created_by_actor_id)
      values
        (${folderA}, ${orgA}, 'IAM 07 A', ${actorA}, ${actorA}),
        (${folderB}, ${orgA}, 'IAM 07 B', ${actorA}, ${actorA})
      on conflict (id) do nothing
    `;
    await database`
      insert into admin_org_units (id, org_id, name, path, created_by)
      values
        (${orgUnitA}, ${orgA}, 'IAM 07 A', 'IAM 07 A', ${actorA}),
        (${orgUnitB}, ${orgB}, 'IAM 07 B', 'IAM 07 B', ${actorB})
      on conflict (id) do nothing
    `;
    await database`
      insert into admin_groups (id, org_id, name, org_unit_id, created_by)
      values (${groupA}, ${orgA}, 'IAM 07', ${orgUnitA}, ${actorA})
      on conflict (id) do nothing
    `;
  });

  afterAll(async () => {
    await database`delete from admin_group_members where group_id = ${groupA}`;
    await database`delete from admin_groups where id = ${groupA}`;
    await database`delete from admin_org_units where id in (${orgUnitA}, ${orgUnitB})`;
    await database`delete from drive_folders where id in (${folderA}, ${folderB})`;
    await database`delete from objects where id = ${objectB}`;
    await database`delete from messages where id = ${messageB}`;
    await database`delete from threads where id = ${threadB}`;
    await database`delete from actors where id in (${actorA}, ${actorB})`;
    await database`delete from orgs where id in (${orgA}, ${orgB})`;
    await database.end();
  });

  it("leaves no foreign key between tenant tables without org_id coupling", async () => {
    const uncovered = await database<{ source_table: string; constraint_name: string }[]>`
      select source_table.relname as source_table, constraint_row.conname as constraint_name
      from pg_constraint constraint_row
      join pg_class source_table on source_table.oid = constraint_row.conrelid
      join pg_class target_table on target_table.oid = constraint_row.confrelid
      join pg_attribute source_org
        on source_org.attrelid = source_table.oid and source_org.attname = 'org_id'
      join pg_attribute target_org
        on target_org.attrelid = target_table.oid and target_org.attname = 'org_id'
      where constraint_row.contype = 'f'
        and not exists (
          select 1
          from generate_subscripts(constraint_row.conkey, 1) key_position(position)
          where constraint_row.conkey[key_position.position] = source_org.attnum
            and constraint_row.confkey[key_position.position] = target_org.attnum
        )
      order by source_table.relname, constraint_row.conname
    `;

    expect(uncovered).toEqual([]);

    const actorReferencesWithoutForeignKeys = await database<
      { table_name: string; column_name: string }[]
    >`
      select relation.relname as table_name, column_row.attname as column_name
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join pg_attribute org_column
        on org_column.attrelid = relation.oid and org_column.attname = 'org_id'
      join pg_attribute column_row
        on column_row.attrelid = relation.oid
        and column_row.attnum > 0
        and not column_row.attisdropped
        and column_row.atttypid = 'uuid'::regtype
      where namespace.nspname = 'public'
        and relation.relkind in ('r', 'p')
        and (
          column_row.attname = 'actor_id'
          or column_row.attname like '%\_actor\_id' escape '\'
          or column_row.attname in ('added_by', 'changed_by', 'created_by', 'updated_by')
        )
        and not exists (
          select 1 from pg_constraint foreign_key
          where foreign_key.contype = 'f'
            and foreign_key.conrelid = relation.oid
            and column_row.attnum = any(foreign_key.conkey)
        )
      order by relation.relname, column_row.attname
    `;

    expect(actorReferencesWithoutForeignKeys).toEqual([]);
  });

  it("rejects representative cross-tenant actor, object, message, folder, and grant links", async () => {
    await expect(
      database`insert into objects (org_id, owner_actor_id, kind, storage_key, mime_type, byte_size)
           values (${orgA}, ${actorB}, 'file', 'iam07/forged', 'text/plain', 1)`,
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      database`insert into messages (org_id, thread_id, kind, body)
           values (${orgA}, ${threadB}, 'system', 'forged')`,
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      database`insert into message_attachments (org_id, message_id, object_id)
           values (${orgA}, ${messageB}, ${objectB})`,
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      database`insert into drive_folders (org_id, name, parent_folder_id)
           values (${orgB}, 'forged', ${folderA})`,
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      database`insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
           values (${orgA}, ${actorA}, 'object', ${objectB}, 'reader', ${actorA})`,
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      database`insert into admin_group_members (org_id, group_id, actor_id, added_by)
           values (${orgA}, ${groupA}, ${actorA}, ${actorB})`,
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      database`update admin_groups set org_unit_id = ${orgUnitB} where id = ${groupA}`,
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects direct folder hierarchy cycles", async () => {
    await database`update drive_folders set parent_folder_id = ${folderA} where id = ${folderB}`;
    await expect(
      database`update drive_folders set parent_folder_id = ${folderB} where id = ${folderA}`,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "drive_folders_acyclic" });
  });
});
