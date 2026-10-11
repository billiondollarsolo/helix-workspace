-- Schema ownership and runtime access are separate. Operators attach secrets
-- to the three LOGIN roles; no credential material belongs in migrations.
--
-- Role DDL requires superuser (SUPERUSER, BYPASSRLS, and REPLICATION are
-- superuser-only attributes). A superuser migrator creates and repairs the
-- roles here. A non-superuser database owner (CloudNativePG initdb owner, the
-- production Compose `helix_migrator`) runs this migration only after the
-- platform bootstrap pre-provisioned every role with exactly these attributes
-- and granted it membership in helix_migration_owner; see
-- docs/deployment-production.md#database. Drift is then reported instead of
-- failing on an ALTER ROLE the owner may not run.

do $$
declare
  desired record;
  existing pg_roles%rowtype;
  can_manage_roles boolean := (select rolsuper from pg_roles where rolname = current_user);
begin
  for desired in
    select *
    from (values
      ('helix_migration_owner', 'alter role helix_migration_owner nologin nosuperuser bypassrls noinherit nocreatedb nocreaterole noreplication', false, true),
      ('helix_app', 'alter role helix_app login nosuperuser nobypassrls noinherit nocreatedb nocreaterole noreplication', true, false),
      ('helix_worker', 'alter role helix_worker login nosuperuser nobypassrls noinherit nocreatedb nocreaterole noreplication', true, false),
      ('helix_readonly', 'alter role helix_readonly login nosuperuser nobypassrls noinherit nocreatedb nocreaterole noreplication', true, false)
    ) as roles(role_name, alter_statement, can_login, bypass_rls)
  loop
    select * into existing from pg_roles where rolname = desired.role_name;
    if not found then
      if not can_manage_roles then
        raise exception 'Helix database role % is missing and % cannot create it.', desired.role_name, current_user
          using hint = 'Pre-provision the Helix roles as a superuser (CloudNativePG bootstrap.initdb.postInitApplicationSQL and managed roles, or infra/postgres/init/002_production_roles.sh), or run this migration once as a superuser.';
      end if;
      execute format('create role %I', desired.role_name);
      execute desired.alter_statement;
    elsif existing.rolsuper
      or existing.rolcanlogin <> desired.can_login
      or existing.rolbypassrls <> desired.bypass_rls
      or existing.rolinherit
      or existing.rolcreatedb
      or existing.rolcreaterole
      or existing.rolreplication then
      if not can_manage_roles then
        raise exception 'Helix database role % has unexpected attributes and % cannot repair them.', desired.role_name, current_user
          using hint = format('Run as a superuser: %s;', desired.alter_statement);
      end if;
      execute desired.alter_statement;
    end if;
  end loop;
end
$$;

do $$
declare
  member_name text;
begin
  for member_name in
    select member_role.rolname
    from pg_auth_members membership
    join pg_roles owner_role on owner_role.oid = membership.roleid
    join pg_roles member_role on member_role.oid = membership.member
    where owner_role.rolname = 'helix_migration_owner'
      and member_role.rolname in ('helix_app', 'helix_worker', 'helix_readonly')
  loop
    execute format('revoke helix_migration_owner from %I', member_name);
  end loop;
end
$$;

do $$
begin
  if current_user <> 'helix_migration_owner'
    and not exists (
      select 1
      from pg_auth_members membership
      join pg_roles owner_role on owner_role.oid = membership.roleid
      join pg_roles member_role on member_role.oid = membership.member
      where owner_role.rolname = 'helix_migration_owner'
        and member_role.rolname = current_user
    ) then
    execute format('grant helix_migration_owner to %I with admin option', current_user);
  end if;
end
$$;

-- The new owner needs CREATE on the schema before it can receive ownership
-- from a non-superuser. Superusers bypass this check, so the order is
-- behaviour-preserving for existing installs.
grant usage, create on schema public to helix_migration_owner;

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
