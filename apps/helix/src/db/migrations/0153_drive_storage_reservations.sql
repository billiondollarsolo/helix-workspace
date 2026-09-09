-- DRV-29: keep quota decisions on two tenant rows. Object/version scans belong
-- only in the repair function below, never in an upload transaction.
create table storage_usage_counters (
  org_id uuid primary key references orgs(id) on delete cascade,
  used_bytes bigint not null default 0 check (used_bytes >= 0),
  reserved_bytes bigint not null default 0 check (reserved_bytes >= 0),
  reconciled_at timestamptz,
  updated_at timestamptz not null default statement_timestamp()
);

create table drive_storage_reservations (
  object_id uuid primary key,
  org_id uuid not null,
  reserved_bytes bigint not null check (reserved_bytes >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  foreign key (org_id, object_id) references objects(org_id, id) on delete cascade
);

create index drive_storage_reservations_expiry_idx
  on drive_storage_reservations (org_id, expires_at);

alter table storage_usage_counters enable row level security;
alter table storage_usage_counters force row level security;
create policy storage_usage_counters_tenant_read on storage_usage_counters for select
  using (org_id = helix_current_org_id());

alter table drive_storage_reservations enable row level security;
alter table drive_storage_reservations force row level security;
create policy drive_storage_reservations_tenant_read on drive_storage_reservations for select
  using (org_id = helix_current_org_id());

-- This is the one intentionally expensive source of truth. It is private and
-- used only for migration backfill and periodic repair.
create function helix_authoritative_storage_usage_bytes(input_org_id uuid)
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select coalesce(sum(stored.byte_size), 0)::bigint
  from (
    select source.storage_key, max(source.byte_size)::bigint as byte_size
    from (
      select object.storage_key, object.byte_size
      from public.objects object
      where object.org_id = input_org_id
        and object.deleted_at is null
        and (
          (object.kind::text in ('file', 'recording')
            and coalesce(object.metadata->>'status', 'ready') = 'ready')
          or object.kind::text = 'chat_attachment'
        )
      union all
      select version.storage_key, version.byte_size
      from public.drive_versions version
      join public.objects object
        on object.org_id = version.org_id and object.id = version.object_id
      where version.org_id = input_org_id
        and object.kind::text in ('file', 'recording')
        and object.deleted_at is null
        and coalesce(object.metadata->>'status', 'ready') = 'ready'
    ) source
    group by source.storage_key
  ) stored
$$;

insert into storage_usage_counters (org_id, used_bytes, reserved_bytes, reconciled_at)
select org.id, helix_authoritative_storage_usage_bytes(org.id), 0, statement_timestamp()
from orgs org;

create function helix_release_drive_storage_reservation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  update public.storage_usage_counters
  set reserved_bytes = greatest(0, reserved_bytes - old.reserved_bytes),
      updated_at = statement_timestamp()
  where org_id = old.org_id;
  return old;
end
$$;

create trigger drive_storage_reservations_release
after delete on drive_storage_reservations
for each row execute function helix_release_drive_storage_reservation();

create function helix_storage_limit_bytes(input_org_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  result bigint;
  tenant_found boolean;
begin
  select true,
    case
      when org.quotas ? 'storage_bytes_limit'
        then nullif(org.quotas->>'storage_bytes_limit', '')::bigint
      when plan.quotas_default ? 'storage_bytes_limit'
        then nullif(plan.quotas_default->>'storage_bytes_limit', '')::bigint
      else 5000000000::bigint
    end
  into tenant_found, result
  from public.orgs org
  left join public.plans plan on plan.id = org.plan_id
  where org.id = input_org_id;
  if not coalesce(tenant_found, false) then
    raise no_data_found using message = 'unknown storage tenant';
  end if;
  return result;
end
$$;

create function helix_write_storage_metering(
  input_org_id uuid,
  input_delta bigint,
  input_bucket text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if input_delta = 0 then return; end if;
  if input_bucket not in ('drive', 'chat', 'meet_recordings', 'storage_reconciliation') then
    raise check_violation using message = 'invalid storage metering bucket';
  end if;
  insert into public.outbox (subject, payload)
  values (
    'metering.events.' || input_org_id::text,
    jsonb_build_object(
      'orgId', input_org_id::text,
      'eventType', 'storage.delta',
      'quantity', input_delta::text,
      'metadata', jsonb_build_object('bucket', input_bucket, 'byte_delta', input_delta::text)
    )
  );
end
$$;

create function helix_reserve_drive_storage(
  input_org_id uuid,
  input_object_id uuid,
  input_bytes bigint,
  input_expires_at timestamptz
)
returns table (
  accepted boolean,
  used_bytes bigint,
  reserved_bytes bigint,
  limit_bytes bigint,
  projected_bytes bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  counter public.storage_usage_counters%rowtype;
  storage_limit bigint;
  projected bigint;
begin
  if input_org_id is distinct from public.helix_current_org_id() then
    raise insufficient_privilege using message = 'storage reservation tenant mismatch';
  end if;
  if input_bytes < 0 or input_expires_at <= statement_timestamp() then
    raise check_violation using message = 'invalid storage reservation';
  end if;
  if not exists (
    select 1 from public.objects object
    where object.org_id = input_org_id and object.id = input_object_id
  ) then
    raise no_data_found using message = 'unknown storage reservation object';
  end if;

  storage_limit := public.helix_storage_limit_bytes(input_org_id);
  insert into public.storage_usage_counters (org_id) values (input_org_id)
  on conflict (org_id) do nothing;
  select * into strict counter from public.storage_usage_counters
  where org_id = input_org_id for update;

  -- The counter lock serializes this delete trigger with every reserve/commit.
  delete from public.drive_storage_reservations
  where org_id = input_org_id and expires_at <= statement_timestamp();
  select * into strict counter from public.storage_usage_counters
  where org_id = input_org_id;
  projected := counter.used_bytes + counter.reserved_bytes + input_bytes;
  if storage_limit is not null and projected > storage_limit then
    return query select false, counter.used_bytes, counter.reserved_bytes, storage_limit, projected;
    return;
  end if;

  insert into public.drive_storage_reservations (object_id, org_id, reserved_bytes, expires_at)
  values (input_object_id, input_org_id, input_bytes, input_expires_at);
  update public.storage_usage_counters usage
  set reserved_bytes = usage.reserved_bytes + input_bytes, updated_at = statement_timestamp()
  where usage.org_id = input_org_id
  returning * into counter;
  return query select true, counter.used_bytes, counter.reserved_bytes, storage_limit, projected;
end
$$;

create function helix_commit_storage_usage(
  input_org_id uuid,
  input_object_id uuid,
  input_delta bigint,
  input_bucket text
)
returns table (
  accepted boolean,
  used_bytes bigint,
  reserved_bytes bigint,
  limit_bytes bigint,
  projected_bytes bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  counter public.storage_usage_counters%rowtype;
  storage_limit bigint;
  held_bytes bigint := 0;
  projected bigint;
  next_used bigint;
  applied_delta bigint;
begin
  if input_org_id is distinct from public.helix_current_org_id() then
    raise insufficient_privilege using message = 'storage commit tenant mismatch';
  end if;
  storage_limit := public.helix_storage_limit_bytes(input_org_id);
  insert into public.storage_usage_counters (org_id) values (input_org_id)
  on conflict (org_id) do nothing;
  select * into strict counter from public.storage_usage_counters
  where org_id = input_org_id for update;
  select reservation.reserved_bytes into held_bytes
  from public.drive_storage_reservations reservation
  where reservation.org_id = input_org_id and reservation.object_id = input_object_id;
  held_bytes := coalesce(held_bytes, 0);
  projected := counter.used_bytes + counter.reserved_bytes - held_bytes + greatest(input_delta, 0);
  if storage_limit is not null and projected > storage_limit then
    return query select false, counter.used_bytes, counter.reserved_bytes, storage_limit, projected;
    return;
  end if;

  delete from public.drive_storage_reservations
  where org_id = input_org_id and object_id = input_object_id;
  next_used := greatest(0, counter.used_bytes + input_delta);
  applied_delta := next_used - counter.used_bytes;
  update public.storage_usage_counters
  set used_bytes = next_used, updated_at = statement_timestamp()
  where org_id = input_org_id
  returning * into counter;
  perform public.helix_write_storage_metering(input_org_id, applied_delta, input_bucket);
  return query select true, counter.used_bytes, counter.reserved_bytes, storage_limit,
    counter.used_bytes + counter.reserved_bytes;
end
$$;

create function helix_reconcile_storage_usage(input_org_id uuid)
returns table (used_bytes bigint, reserved_bytes bigint, correction_bytes bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  counter public.storage_usage_counters%rowtype;
  authoritative bigint;
  reserved bigint;
  correction bigint;
begin
  if input_org_id is distinct from public.helix_current_org_id() then
    raise insufficient_privilege using message = 'storage reconciliation tenant mismatch';
  end if;
  perform public.helix_storage_limit_bytes(input_org_id);
  insert into public.storage_usage_counters (org_id) values (input_org_id)
  on conflict (org_id) do nothing;
  select * into strict counter from public.storage_usage_counters
  where org_id = input_org_id for update;
  delete from public.drive_storage_reservations
  where org_id = input_org_id and expires_at <= statement_timestamp();
  authoritative := public.helix_authoritative_storage_usage_bytes(input_org_id);
  select coalesce(sum(reservation.reserved_bytes), 0)::bigint into reserved
  from public.drive_storage_reservations reservation where reservation.org_id = input_org_id;
  correction := authoritative - counter.used_bytes;
  update public.storage_usage_counters
  set used_bytes = authoritative, reserved_bytes = reserved,
      reconciled_at = statement_timestamp(), updated_at = statement_timestamp()
  where org_id = input_org_id;
  perform public.helix_write_storage_metering(
    input_org_id, correction, 'storage_reconciliation'
  );
  return query select authoritative, reserved, correction;
end
$$;

-- Preserve the established API while making ordinary quota reads O(1).
create or replace function helix_storage_usage_bytes(input_org_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  result bigint;
begin
  if input_org_id is distinct from public.helix_current_org_id() then
    raise insufficient_privilege using message = 'storage quota tenant mismatch';
  end if;
  perform public.helix_storage_limit_bytes(input_org_id);
  select counter.used_bytes into result from public.storage_usage_counters counter
  where counter.org_id = input_org_id;
  return coalesce(result, 0);
end
$$;

alter table storage_usage_counters owner to helix_migration_owner;
alter table drive_storage_reservations owner to helix_migration_owner;
alter function helix_authoritative_storage_usage_bytes(uuid) owner to helix_migration_owner;
alter function helix_release_drive_storage_reservation() owner to helix_migration_owner;
alter function helix_storage_limit_bytes(uuid) owner to helix_migration_owner;
alter function helix_write_storage_metering(uuid, bigint, text) owner to helix_migration_owner;
alter function helix_reserve_drive_storage(uuid, uuid, bigint, timestamptz) owner to helix_migration_owner;
alter function helix_commit_storage_usage(uuid, uuid, bigint, text) owner to helix_migration_owner;
alter function helix_reconcile_storage_usage(uuid) owner to helix_migration_owner;
alter function helix_storage_usage_bytes(uuid) owner to helix_migration_owner;

revoke all on storage_usage_counters, drive_storage_reservations
  from public, helix_app, helix_worker, helix_readonly;
grant select on storage_usage_counters, drive_storage_reservations
  to helix_app, helix_worker, helix_readonly;
revoke all on function helix_authoritative_storage_usage_bytes(uuid) from public;
revoke all on function helix_release_drive_storage_reservation() from public;
revoke all on function helix_storage_limit_bytes(uuid) from public;
revoke all on function helix_write_storage_metering(uuid, bigint, text) from public;
revoke all on function helix_reserve_drive_storage(uuid, uuid, bigint, timestamptz) from public;
revoke all on function helix_commit_storage_usage(uuid, uuid, bigint, text) from public;
revoke all on function helix_reconcile_storage_usage(uuid) from public;
revoke all on function helix_storage_usage_bytes(uuid) from public;
grant execute on function helix_reserve_drive_storage(uuid, uuid, bigint, timestamptz),
  helix_commit_storage_usage(uuid, uuid, bigint, text),
  helix_reconcile_storage_usage(uuid),
  helix_storage_usage_bytes(uuid) to helix_app, helix_worker;
