-- A tenant-owned foreign key is incomplete unless the tenant is part of the
-- relationship. Harden every relationship already present in the catalog so
-- direct SQL cannot connect rows owned by different organizations.

-- 0007 created this constraint and 0073 added its intended replacement without
-- removing the original. Keep the SET NULL behavior and remove the duplicate.
alter table drive_folders
  drop constraint if exists drive_folders_parent_folder_id_fkey;

-- Several older tables stored actor identifiers without declaring a foreign
-- key. Add the tenant-scoped relationship wherever the column name identifies
-- an actor unambiguously; historical polymorphic object identifiers remain
-- intentionally detached.
do $$
declare
  actor_reference record;
  has_cross_tenant_rows boolean;
begin
  for actor_reference in
    select
      namespace.nspname as table_schema,
      relation.relname as table_name,
      column_row.attname as column_name
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_attribute org_column
      on org_column.attrelid = relation.oid
      and org_column.attname = 'org_id'
      and not org_column.attisdropped
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
        select 1
        from pg_constraint existing_fk
        where existing_fk.contype = 'f'
          and existing_fk.conrelid = relation.oid
          and column_row.attnum = any(existing_fk.conkey)
      )
    order by namespace.nspname, relation.relname, column_row.attname
  loop
    execute format(
      'select exists (
         select 1
         from %I.%I source
         join actors target on target.id = source.%I
         where source.org_id is distinct from target.org_id
       )',
      actor_reference.table_schema,
      actor_reference.table_name,
      actor_reference.column_name
    ) into has_cross_tenant_rows;

    if has_cross_tenant_rows then
      raise foreign_key_violation using
        message = format(
          '%I.%I contains a cross-tenant actor relationship in %I',
          actor_reference.table_schema,
          actor_reference.table_name,
          actor_reference.column_name
        );
    end if;

    execute format(
      'alter table %I.%I add constraint %I foreign key (org_id, %I) references actors (org_id, id)',
      actor_reference.table_schema,
      actor_reference.table_name,
      'helix_actor_ref_' || substr(md5(
        actor_reference.table_schema || '.' || actor_reference.table_name ||
        '.' || actor_reference.column_name
      ), 1, 20) || '_fk',
      actor_reference.column_name
    );
  end loop;
end
$$;

do $$
declare
  relationship record;
  delete_action text;
  update_action text;
  match_clause text;
  deferrability text;
  has_cross_tenant_rows boolean;
begin
  for relationship in
    select
      constraint_row.oid,
      constraint_row.conname,
      source_namespace.nspname as source_schema,
      source_table.relname as source_table,
      target_namespace.nspname as target_schema,
      target_table.relname as target_table,
      constraint_row.confdeltype,
      constraint_row.confupdtype,
      constraint_row.confmatchtype,
      constraint_row.condeferrable,
      constraint_row.condeferred,
      string_agg(format('%I', source_column.attname), ', ' order by key_position.position)
        as source_columns,
      string_agg(format('%I', target_column.attname), ', ' order by key_position.position)
        as target_columns,
      string_agg(
        format('source.%I = target.%I', source_column.attname, target_column.attname),
        ' and ' order by key_position.position
      ) as join_predicate
    from pg_constraint constraint_row
    join pg_class source_table on source_table.oid = constraint_row.conrelid
    join pg_namespace source_namespace on source_namespace.oid = source_table.relnamespace
    join pg_class target_table on target_table.oid = constraint_row.confrelid
    join pg_namespace target_namespace on target_namespace.oid = target_table.relnamespace
    join pg_attribute source_org
      on source_org.attrelid = source_table.oid
      and source_org.attname = 'org_id'
      and not source_org.attisdropped
    join pg_attribute target_org
      on target_org.attrelid = target_table.oid
      and target_org.attname = 'org_id'
      and not target_org.attisdropped
    cross join lateral generate_subscripts(constraint_row.conkey, 1) key_position(position)
    join pg_attribute source_column
      on source_column.attrelid = source_table.oid
      and source_column.attnum = constraint_row.conkey[key_position.position]
    join pg_attribute target_column
      on target_column.attrelid = target_table.oid
      and target_column.attnum = constraint_row.confkey[key_position.position]
    where constraint_row.contype = 'f'
      and source_namespace.nspname = 'public'
      and target_namespace.nspname = 'public'
      and not exists (
        select 1
        from generate_subscripts(constraint_row.conkey, 1) existing_key(position)
        where constraint_row.conkey[existing_key.position] = source_org.attnum
          and constraint_row.confkey[existing_key.position] = target_org.attnum
      )
    group by
      constraint_row.oid,
      constraint_row.conname,
      source_namespace.nspname,
      source_table.relname,
      target_namespace.nspname,
      target_table.relname,
      constraint_row.confdeltype,
      constraint_row.confupdtype,
      constraint_row.confmatchtype,
      constraint_row.condeferrable,
      constraint_row.condeferred
    order by source_namespace.nspname, source_table.relname, constraint_row.conname
  loop
    execute format(
      'select exists (
         select 1
         from %I.%I source
         join %I.%I target on %s
         where source.org_id is distinct from target.org_id
       )',
      relationship.source_schema,
      relationship.source_table,
      relationship.target_schema,
      relationship.target_table,
      relationship.join_predicate
    ) into has_cross_tenant_rows;

    if has_cross_tenant_rows then
      raise foreign_key_violation using
        constraint = relationship.conname,
        message = format(
          '%I.%I contains a cross-tenant relationship rejected by %I',
          relationship.source_schema,
          relationship.source_table,
          relationship.conname
        );
    end if;

    execute format(
      'create unique index if not exists %I on %I.%I (org_id, %s)',
      'helix_tenant_ref_' || substr(md5(
        relationship.target_schema || '.' || relationship.target_table ||
        '(org_id,' || relationship.target_columns || ')'
      ), 1, 20) || '_uidx',
      relationship.target_schema,
      relationship.target_table,
      relationship.target_columns
    );

    delete_action := case relationship.confdeltype
      when 'r' then ' on delete restrict'
      when 'c' then ' on delete cascade'
      when 'n' then format(' on delete set null (%s)', relationship.source_columns)
      when 'd' then format(' on delete set default (%s)', relationship.source_columns)
      else ' on delete no action'
    end;
    update_action := case relationship.confupdtype
      when 'r' then ' on update restrict'
      when 'c' then ' on update cascade'
      when 'n' then ' on update set null'
      when 'd' then ' on update set default'
      else ' on update no action'
    end;
    match_clause := case relationship.confmatchtype
      when 'f' then ' match full'
      when 'p' then ' match partial'
      else ' match simple'
    end;
    deferrability := case
      when not relationship.condeferrable then ' not deferrable'
      when relationship.condeferred then ' deferrable initially deferred'
      else ' deferrable initially immediate'
    end;

    execute format(
      'alter table %I.%I drop constraint %I',
      relationship.source_schema,
      relationship.source_table,
      relationship.conname
    );
    execute format(
      'alter table %I.%I add constraint %I foreign key (org_id, %s) references %I.%I (org_id, %s)%s%s%s%s',
      relationship.source_schema,
      relationship.source_table,
      relationship.conname,
      relationship.source_columns,
      relationship.target_schema,
      relationship.target_table,
      relationship.target_columns,
      match_clause,
      update_action,
      delete_action,
      deferrability
    );
  end loop;
end
$$;

-- permissions.resource_id is polymorphic, so it cannot use one declarative
-- foreign key. Validate every supported resource kind against its tenant-owned
-- target table instead.
create or replace function permissions_require_tenant_resource()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.resource_type = 'org' then
    if new.resource_id is distinct from new.org_id then
      raise foreign_key_violation using constraint = 'permissions_resource_org_fk';
    end if;
    return new;
  elsif new.resource_type = 'mailbox' then
    perform 1 from actors where org_id = new.org_id and id = new.resource_id;
  elsif new.resource_type = 'object' then
    perform 1 from objects where org_id = new.org_id and id = new.resource_id;
  elsif new.resource_type in ('drive_folder', 'folder') then
    perform 1 from drive_folders where org_id = new.org_id and id = new.resource_id;
  elsif new.resource_type = 'thread' then
    perform 1 from threads where org_id = new.org_id and id = new.resource_id;
  elsif new.resource_type = 'document' then
    perform 1 from docs_documents where org_id = new.org_id and id = new.resource_id;
  elsif new.resource_type = 'sheet' then
    perform 1 from sheets where org_id = new.org_id and id = new.resource_id;
  elsif new.resource_type = 'slide_deck' then
    perform 1 from slide_decks where org_id = new.org_id and id = new.resource_id;
  elsif new.resource_type = 'calendar' then
    perform 1 from cal_calendars where org_id = new.org_id and id = new.resource_id;
  elsif new.resource_type = 'event' then
    perform 1 from cal_events where org_id = new.org_id and id = new.resource_id;
  elsif new.resource_type = 'meet_room' then
    perform 1 from meet_rooms where org_id = new.org_id and id = new.resource_id;
  else
    return new;
  end if;

  if not found then
    raise foreign_key_violation using
      constraint = 'permissions_resource_org_fk',
      message = 'permission resource must belong to the same organization';
  end if;
  return new;
end
$$;

drop trigger if exists permissions_require_tenant_resource on permissions;
create trigger permissions_require_tenant_resource
before insert or update of org_id, resource_type, resource_id on permissions
for each row execute function permissions_require_tenant_resource();

-- A composite self-FK prevents cross-tenant parents. The trigger closes the
-- other structural hole: cycles created by direct SQL.
alter table drive_folders
  add constraint drive_folders_no_self_parent
  check (parent_folder_id is distinct from id);

do $$
declare
  unrooted_count bigint;
begin
  with recursive rooted as (
    select id, org_id
    from drive_folders
    where parent_folder_id is null

    union all

    select child.id, child.org_id
    from drive_folders child
    join rooted parent
      on parent.org_id = child.org_id and parent.id = child.parent_folder_id
  )
  select count(*) into unrooted_count
  from drive_folders folder
  where not exists (
    select 1 from rooted where rooted.org_id = folder.org_id and rooted.id = folder.id
  );

  if unrooted_count > 0 then
    raise check_violation using
      constraint = 'drive_folders_acyclic',
      message = 'drive folder hierarchy contains a cycle';
  end if;
end
$$;

create or replace function drive_folders_require_acyclic_parent()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if TG_OP = 'UPDATE' and new.org_id is distinct from old.org_id then
    raise check_violation using
      constraint = 'drive_folders_org_id_immutable',
      message = 'drive folders cannot move between organizations';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.org_id::text, 0));

  if new.parent_folder_id is null then
    return new;
  end if;

  if exists (
    with recursive ancestors as (
      select id, parent_folder_id
      from drive_folders
      where org_id = new.org_id and id = new.parent_folder_id

      union

      select parent.id, parent.parent_folder_id
      from drive_folders parent
      join ancestors child on child.parent_folder_id = parent.id
      where parent.org_id = new.org_id
    )
    select 1 from ancestors where id = new.id
  ) then
    raise check_violation using
      constraint = 'drive_folders_acyclic',
      message = 'a drive folder cannot be moved below its descendant';
  end if;

  return new;
end
$$;

drop trigger if exists drive_folders_require_acyclic_parent on drive_folders;
create trigger drive_folders_require_acyclic_parent
before insert or update of org_id, parent_folder_id on drive_folders
for each row execute function drive_folders_require_acyclic_parent();
