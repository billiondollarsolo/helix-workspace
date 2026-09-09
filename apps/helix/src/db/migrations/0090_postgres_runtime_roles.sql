-- Schema ownership and runtime access are separate. Operators attach secrets
-- to the three LOGIN roles; no credential material belongs in migrations.

do $$
declare
  role_name text;
begin
  foreach role_name in array array[
    'helix_migration_owner', 'helix_app', 'helix_worker', 'helix_readonly'
  ]
  loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format('create role %I', role_name);
    end if;
  end loop;
end
$$;

alter role helix_migration_owner nologin nosuperuser bypassrls noinherit
  nocreatedb nocreaterole noreplication;
alter role helix_app login nosuperuser nobypassrls noinherit
  nocreatedb nocreaterole noreplication;
alter role helix_worker login nosuperuser nobypassrls noinherit
  nocreatedb nocreaterole noreplication;
alter role helix_readonly login nosuperuser nobypassrls noinherit
  nocreatedb nocreaterole noreplication;

revoke helix_migration_owner from helix_app, helix_worker, helix_readonly;

do $$
begin
  if current_user <> 'helix_migration_owner' then
    execute format('grant helix_migration_owner to %I with admin option', current_user);
  end if;
end
$$;

do $$
declare
  relation record;
  routine record;
  owned_type record;
begin
  for relation in
    select n.nspname, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format(
      'alter table %I.%I owner to helix_migration_owner',
      relation.nspname,
      relation.relname
    );
  end loop;

  for relation in
    select n.nspname, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
  loop
    execute format(
      'alter sequence %I.%I owner to helix_migration_owner',
      relation.nspname,
      relation.relname
    );
  end loop;

  for relation in
    select n.nspname, c.relname, c.relkind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v', 'm')
  loop
    execute format(
      'alter %s %I.%I owner to helix_migration_owner',
      case relation.relkind when 'm' then 'materialized view' else 'view' end,
      relation.nspname,
      relation.relname
    );
  end loop;

  for routine in
    select
      n.nspname,
      p.proname,
      p.prokind,
      pg_get_function_identity_arguments(p.oid) as arguments
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and not exists (
        select 1 from pg_depend dependency
        where dependency.classid = 'pg_proc'::regclass
          and dependency.objid = p.oid
          and dependency.deptype = 'e'
      )
  loop
    execute format(
      'alter %s %I.%I(%s) owner to helix_migration_owner',
      case routine.prokind when 'p' then 'procedure' else 'function' end,
      routine.nspname,
      routine.proname,
      routine.arguments
    );
  end loop;

  for owned_type in
    select n.nspname, t.typname
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typtype in ('d', 'e')
      and not exists (
        select 1 from pg_depend dependency
        where dependency.classid = 'pg_type'::regclass
          and dependency.objid = t.oid
          and dependency.deptype = 'e'
      )
  loop
    execute format(
      'alter type %I.%I owner to helix_migration_owner',
      owned_type.nspname,
      owned_type.typname
    );
  end loop;
end
$$;

revoke create on schema public from public;
grant usage on schema public to helix_app, helix_worker, helix_readonly;
grant usage, create on schema public to helix_migration_owner;

revoke all on all tables in schema public from helix_app, helix_worker, helix_readonly;
revoke all on all sequences in schema public from helix_app, helix_worker, helix_readonly;
revoke execute on all functions in schema public from public;
grant select, insert, update, delete on all tables in schema public to helix_app, helix_worker;
grant select on all tables in schema public to helix_readonly;
grant usage, select, update on all sequences in schema public to helix_app, helix_worker;
grant select on all sequences in schema public to helix_readonly;
grant execute on all functions in schema public to helix_migration_owner, helix_app, helix_worker;
grant execute on function helix_current_org_id() to helix_readonly;

alter default privileges for role helix_migration_owner in schema public
  grant select, insert, update, delete on tables to helix_app, helix_worker;
alter default privileges for role helix_migration_owner in schema public
  grant select on tables to helix_readonly;
alter default privileges for role helix_migration_owner in schema public
  grant usage, select, update on sequences to helix_app, helix_worker;
alter default privileges for role helix_migration_owner in schema public
  grant select on sequences to helix_readonly;
alter default privileges for role helix_migration_owner in schema public
  revoke execute on functions from public;
alter default privileges for role helix_migration_owner in schema public
  grant execute on functions to helix_app, helix_worker;

-- The migration executor records this migration after the ownership transfer.
do $$
begin
  execute format(
    'grant select, insert, update, delete on table public.schema_migrations to %I',
    current_user
  );
end
$$;
