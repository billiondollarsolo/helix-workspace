create table tenant_deletion_proofs (
  org_id uuid primary key references orgs(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'blocked', 'running', 'completed', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  completed_steps text[] not null default '{}',
  object_keys jsonb not null default '[]'::jsonb check (jsonb_typeof(object_keys) = 'array'),
  blockers jsonb not null default '[]'::jsonb check (jsonb_typeof(blockers) = 'array'),
  system_actor_id uuid not null default gen_random_uuid(),
  sql_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(sql_counts) = 'object'),
  manifest jsonb,
  manifest_sha256 text check (manifest_sha256 is null or manifest_sha256 ~ '^[a-f0-9]{64}$'),
  proof_signature text,
  proof_key_id text,
  proof_object_key text,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default statement_timestamp(),
  check (
    (status = 'completed' and manifest is not null and manifest_sha256 is not null
      and proof_signature is not null and proof_key_id is not null
      and proof_object_key is not null and completed_at is not null)
    or status <> 'completed'
  )
);

alter table tenant_deletion_proofs enable row level security;
alter table tenant_deletion_proofs force row level security;
create policy tenant_deletion_proofs_tenant_read on tenant_deletion_proofs for select
  using (org_id = helix_current_org_id());

create function helix_tenant_deletion_blockers(input_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select coalesce(jsonb_agg(blocker order by blocker->>'type'), '[]'::jsonb)
  from (
    select jsonb_build_object('type', 'mail_hold', 'count', count(*)) blocker
    from mail_retention_holds
    where org_id = input_org_id and (expires_at is null or expires_at > statement_timestamp())
    having count(*) > 0
    union all
    select jsonb_build_object('type', 'drive_hold', 'count', count(*))
    from drive_retention_holds
    where org_id = input_org_id and released_at is null
      and (expires_at is null or expires_at > statement_timestamp())
    having count(*) > 0
    union all
    select jsonb_build_object('type', 'drive_retention', 'count', count(*))
    from (
      select id from objects where org_id = input_org_id and retain_until > statement_timestamp()
      union all
      select id from drive_folders where org_id = input_org_id and retain_until > statement_timestamp()
    ) retained_drive
    having count(*) > 0
    union all
    select jsonb_build_object('type', 'recording_hold_or_retention', 'count', count(*))
    from meet_recording_governance
    where org_id = input_org_id
      and (legal_hold or retention_until > statement_timestamp())
    having count(*) > 0
  ) blockers
$$;

create function helix_prepare_tenant_deletion(input_org_id uuid)
returns tenant_deletion_proofs
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  tenant_status text;
  found_blockers jsonb;
  relation record;
  found_keys text[];
  all_keys text[] := '{}';
  result tenant_deletion_proofs%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('tenant-delete:' || input_org_id::text, 0));
  select status into tenant_status from orgs where id = input_org_id for update;
  if tenant_status is null then raise foreign_key_violation using message = 'tenant not found'; end if;
  if tenant_status not in ('soft_deleted', 'hard_deleted') then
    raise object_not_in_prerequisite_state using message = 'tenant must be soft-deleted first';
  end if;

  select * into result from tenant_deletion_proofs where org_id = input_org_id;
  if result.status = 'completed' then return result; end if;

  found_blockers := helix_tenant_deletion_blockers(input_org_id);
  if result.org_id is null then
    for relation in
      select table_name, column_name
      from information_schema.columns column_definition
      where table_schema = 'public'
        and column_name in ('storage_key', 'object_key')
        and exists (
          select 1 from information_schema.columns tenant_column
          where tenant_column.table_schema = 'public'
            and tenant_column.table_name = column_definition.table_name
            and tenant_column.column_name = 'org_id'
        )
      order by table_name, column_name
    loop
      execute format(
        'select coalesce(array_agg(distinct %1$I), ARRAY[]::text[]) from public.%2$I where org_id = $1 and %1$I is not null',
        relation.column_name, relation.table_name
      ) into found_keys using input_org_id;
      all_keys := all_keys || found_keys;
    end loop;
    select coalesce(array_agg(distinct key order by key), '{}') into all_keys from unnest(all_keys) key;
  else
    select coalesce(array_agg(value), '{}') into all_keys
    from jsonb_array_elements_text(result.object_keys) value;
  end if;

  insert into tenant_deletion_proofs (
    org_id, status, attempt_count, object_keys, blockers, started_at, last_error, updated_at
  ) values (
    input_org_id,
    case when jsonb_array_length(found_blockers) = 0 then 'running' else 'blocked' end,
    1,
    to_jsonb(all_keys),
    found_blockers,
    statement_timestamp(),
    case when jsonb_array_length(found_blockers) = 0 then null else 'retention or legal hold blocks deletion' end,
    statement_timestamp()
  )
  on conflict (org_id) do update set
    status = excluded.status,
    attempt_count = tenant_deletion_proofs.attempt_count + 1,
    blockers = excluded.blockers,
    last_error = excluded.last_error,
    updated_at = excluded.updated_at
  returning * into result;
  return result;
end
$$;

create function helix_purge_tenant_sql(input_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  target record;
  affected bigint;
  pass_progress boolean;
  remaining integer;
  counts jsonb := '{}'::jsonb;
  system_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('tenant-delete:' || input_org_id::text, 0));
  if not exists (select 1 from orgs where id = input_org_id and status in ('soft_deleted', 'hard_deleted')) then
    raise object_not_in_prerequisite_state using message = 'tenant must be soft-deleted first';
  end if;
  if jsonb_array_length(helix_tenant_deletion_blockers(input_org_id)) > 0 then
    raise object_not_in_prerequisite_state using message = 'retention or legal hold blocks deletion';
  end if;

  select system_actor_id into strict system_id from tenant_deletion_proofs where org_id = input_org_id;
  create temporary table helix_delete_subjects on commit drop as
    select distinct membership.subject_id,
      provider.provider_subject as better_auth_user_id
    from organization_memberships membership
    left join identity_provider_subjects provider
      on provider.subject_id = membership.subject_id and provider.provider = 'better-auth'
    where membership.org_id = input_org_id;
  create temporary table helix_delete_tables (
    table_name text primary key, completed boolean not null default false
  ) on commit drop;
  insert into helix_delete_tables (table_name)
  select table_name
  from information_schema.columns
  where table_schema = 'public' and column_name = 'org_id'
    and table_name not in ('activity', 'audit_chain_heads', 'tenant_deletion_proofs', 'orgs', 'actors')
  group by table_name;

  -- Tenant deletion is the sole path allowed to bypass product audit/projection triggers.
  -- FK constraints stay enabled; the loop naturally finds a child-before-parent order.
  for target in select table_name from helix_delete_tables order by table_name loop
    execute format('alter table public.%I disable trigger user', target.table_name);
  end loop;
  loop
    pass_progress := false;
    for target in select table_name from helix_delete_tables where not completed order by table_name loop
      begin
        execute format('delete from public.%I where org_id = $1', target.table_name)
          using input_org_id;
        get diagnostics affected = row_count;
        counts := counts || jsonb_build_object(target.table_name, affected);
        update helix_delete_tables set completed = true where table_name = target.table_name;
        pass_progress := true;
      exception when foreign_key_violation then
        null;
      end;
    end loop;
    select count(*) into remaining from helix_delete_tables where not completed;
    exit when remaining = 0;
    if not pass_progress then
      raise foreign_key_violation using message = 'tenant SQL purge could not resolve foreign-key order';
    end if;
  end loop;
  for target in select table_name from helix_delete_tables order by table_name loop
    execute format('alter table public.%I enable trigger user', target.table_name);
  end loop;

  delete from app_passwords where actor_id in (select id from actors where org_id = input_org_id);
  get diagnostics affected = row_count;
  counts := counts || jsonb_build_object('app_passwords', affected);
  delete from agent_credentials
  where actor_id in (select id from actors where org_id = input_org_id)
     or created_by in (select id from actors where org_id = input_org_id);
  get diagnostics affected = row_count;
  counts := counts || jsonb_build_object('agent_credentials', affected);
  update platform_config set updated_by_actor_id = null
  where updated_by_actor_id in (select id from actors where org_id = input_org_id);

  delete from "user" local_user
  using helix_delete_subjects subject
  where local_user.id = subject.better_auth_user_id
    and not exists (
      select 1 from organization_memberships membership
      where membership.subject_id = subject.subject_id
    );
  delete from identity_subjects subject
  using helix_delete_subjects deleted_subject
  where subject.id = deleted_subject.subject_id
    and not exists (
      select 1 from organization_memberships membership where membership.subject_id = subject.id
    );

  delete from actors actor
  where actor.org_id = input_org_id
    and not exists (select 1 from activity event where event.actor_id = actor.id);
  update actors set
    parent_user_id = null,
    email = null,
    display_name = 'Deleted audit principal',
    scopes = '{}',
    disabled_at = coalesce(disabled_at, statement_timestamp()),
    metadata = jsonb_build_object('retainedFor', 'audit-chain'),
    scim_external_id = null,
    updated_at = statement_timestamp()
  where org_id = input_org_id;
  insert into actors (id, org_id, type, email, display_name, scopes, disabled_at, metadata)
  values (
    system_id, input_org_id, 'system', null, 'Tenant deletion system', '{}',
    statement_timestamp(), jsonb_build_object('retainedFor', 'tenant-deletion-proof')
  ) on conflict (id) do nothing;

  alter table orgs disable trigger user;
  update orgs set
    display_name = 'Deleted tenant',
    byo_config = '{}'::jsonb,
    feature_flags = '{}'::jsonb,
    quotas = '{}'::jsonb,
    branding = '{}'::jsonb,
    updated_at = statement_timestamp()
  where id = input_org_id;
  alter table orgs enable trigger user;

  update tenant_deletion_proofs
  set sql_counts = counts,
      completed_steps = array_append(completed_steps, 'sql'),
      updated_at = statement_timestamp()
  where org_id = input_org_id and not ('sql' = any(completed_steps));
  return counts;
end
$$;

create function helix_record_tenant_deletion_step(input_org_id uuid, input_step text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if input_step not in ('objects', 'search', 'cache', 'secrets') then
    raise invalid_parameter_value using message = 'invalid tenant deletion step';
  end if;
  update tenant_deletion_proofs set
    completed_steps = case when input_step = any(completed_steps)
      then completed_steps else array_append(completed_steps, input_step) end,
    updated_at = statement_timestamp()
  where org_id = input_org_id and status <> 'completed';
  if not found then raise object_not_in_prerequisite_state; end if;
end
$$;

create function helix_complete_tenant_deletion(
  input_org_id uuid,
  input_manifest jsonb,
  input_sha256 text,
  input_signature text,
  input_key_id text,
  input_object_key text
)
returns tenant_deletion_proofs
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare result tenant_deletion_proofs%rowtype;
begin
  if input_sha256 !~ '^[a-f0-9]{64}$' or nullif(input_signature, '') is null
    or nullif(input_key_id, '') is null or nullif(input_object_key, '') is null
    or jsonb_typeof(input_manifest) <> 'object'
  then raise invalid_parameter_value using message = 'invalid tenant deletion proof'; end if;
  update tenant_deletion_proofs set
    status = 'completed',
    manifest = input_manifest,
    manifest_sha256 = input_sha256,
    proof_signature = input_signature,
    proof_key_id = input_key_id,
    proof_object_key = input_object_key,
    completed_steps = array_append(completed_steps, 'proof'),
    completed_at = statement_timestamp(),
    last_error = null,
    updated_at = statement_timestamp()
  where org_id = input_org_id
    and status <> 'completed'
    and completed_steps @> array['objects', 'search', 'cache', 'secrets', 'sql']::text[]
  returning * into result;
  if result.org_id is null then
    select * into strict result from tenant_deletion_proofs where org_id = input_org_id;
    if result.status <> 'completed' then
      raise object_not_in_prerequisite_state using message = 'tenant deletion phases are incomplete';
    end if;
  end if;
  return result;
end
$$;

create function helix_tenant_deletion_proof_immutable()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if old.status = 'completed' then
    raise integrity_constraint_violation using message = 'completed tenant deletion proof is immutable';
  end if;
  return new;
end
$$;
create trigger tenant_deletion_proofs_immutable
before update or delete on tenant_deletion_proofs
for each row execute function helix_tenant_deletion_proof_immutable();

alter table tenant_deletion_proofs owner to helix_migration_owner;
alter function helix_tenant_deletion_blockers(uuid) owner to helix_migration_owner;
alter function helix_prepare_tenant_deletion(uuid) owner to helix_migration_owner;
alter function helix_purge_tenant_sql(uuid) owner to helix_migration_owner;
alter function helix_record_tenant_deletion_step(uuid, text) owner to helix_migration_owner;
alter function helix_complete_tenant_deletion(uuid, jsonb, text, text, text, text) owner to helix_migration_owner;
alter function helix_tenant_deletion_proof_immutable() owner to helix_migration_owner;
revoke all on tenant_deletion_proofs from public, helix_app, helix_worker, helix_readonly;
grant select on tenant_deletion_proofs to helix_app, helix_worker, helix_readonly;
revoke all on function helix_tenant_deletion_blockers(uuid) from public;
revoke all on function helix_prepare_tenant_deletion(uuid) from public;
revoke all on function helix_purge_tenant_sql(uuid) from public;
revoke all on function helix_record_tenant_deletion_step(uuid, text) from public;
revoke all on function helix_complete_tenant_deletion(uuid, jsonb, text, text, text, text) from public;
grant execute on function helix_prepare_tenant_deletion(uuid) to helix_app, helix_worker;
grant execute on function helix_purge_tenant_sql(uuid) to helix_app, helix_worker;
grant execute on function helix_record_tenant_deletion_step(uuid, text) to helix_app, helix_worker;
grant execute on function helix_complete_tenant_deletion(uuid, jsonb, text, text, text, text) to helix_app, helix_worker;
