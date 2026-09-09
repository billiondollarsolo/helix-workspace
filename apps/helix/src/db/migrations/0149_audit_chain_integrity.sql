alter table activity
  add column schema_version integer not null default 1 check (schema_version > 0),
  add column sequence bigint;

create or replace function helix_canonical_jsonb(input jsonb)
returns text
language plpgsql
immutable
strict
set search_path = pg_catalog, public
as $$
declare
  kind text := jsonb_typeof(input);
  result text;
begin
  if kind = 'object' then
    select '{' || coalesce(string_agg(to_jsonb(entry.key)::text || ':' || helix_canonical_jsonb(entry.value), ',' order by entry.key), '') || '}'
    into result
    from jsonb_each(input) entry;
    return result;
  end if;
  if kind = 'array' then
    select '[' || coalesce(string_agg(helix_canonical_jsonb(entry.value), ',' order by entry.ordinality), '') || ']'
    into result
    from jsonb_array_elements(input) with ordinality entry(value, ordinality);
    return result;
  end if;
  return input::text;
end
$$;

create or replace function helix_audit_event_hash(
  input_schema_version integer,
  input_org_id uuid,
  input_event_id uuid,
  input_sequence bigint,
  input_actor_id uuid,
  input_verb text,
  input_object_type text,
  input_object_id uuid,
  input_trace_id text,
  input_payload jsonb,
  input_created_at timestamptz,
  input_prev_hash text
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select encode(
    digest(
      convert_to(
        helix_canonical_jsonb(jsonb_build_object(
          'actorId', coalesce(input_actor_id::text, 'system'),
          'createdAt', to_char(input_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'eventId', input_event_id::text,
          'metadata', input_payload,
          'objectId', input_object_id::text,
          'objectType', input_object_type,
          'onBehalfOfActorId', null,
          'orgId', input_org_id::text,
          'prevHash', input_prev_hash,
          'schemaVersion', input_schema_version,
          'sequence', input_sequence::text,
          'spanId', null,
          'toolId', null,
          'traceId', input_trace_id,
          'verb', input_verb
        )),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

create table audit_chain_heads (
  org_id uuid primary key references orgs(id) on delete cascade,
  last_sequence bigint not null check (last_sequence >= 0),
  last_hash text,
  check ((last_sequence = 0) = (last_hash is null))
);

alter table audit_chain_heads enable row level security;
alter table audit_chain_heads force row level security;
create policy audit_chain_heads_tenant_read on audit_chain_heads for select
  using (org_id = helix_current_org_id());

do $$
declare
  tenant record;
  event record;
  next_sequence bigint;
  previous_hash text;
  event_hash text;
begin
  for tenant in select distinct org_id from activity order by org_id loop
    next_sequence := 0;
    previous_hash := null;
    for event in
      select * from activity where org_id = tenant.org_id order by created_at, id
    loop
      next_sequence := next_sequence + 1;
      event.created_at := date_trunc('milliseconds', event.created_at);
      event_hash := helix_audit_event_hash(
        1,
        event.org_id,
        event.id,
        next_sequence,
        event.actor_id,
        event.verb,
        event.object_type,
        event.object_id,
        event.trace_id,
        event.payload,
        event.created_at,
        previous_hash
      );
      update activity
      set schema_version = 1,
          sequence = next_sequence,
          prev_hash = previous_hash,
          this_hash = event_hash,
          created_at = event.created_at
      where id = event.id;
      previous_hash := event_hash;
    end loop;
    insert into audit_chain_heads (org_id, last_sequence, last_hash)
    values (tenant.org_id, next_sequence, previous_hash);
  end loop;
end
$$;

alter table activity alter column sequence set not null;
alter table activity add constraint activity_org_sequence_unique unique (org_id, sequence);

create or replace function helix_chain_activity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  head audit_chain_heads%rowtype;
begin
  new.created_at := date_trunc('milliseconds', coalesce(new.created_at, clock_timestamp()));
  new.schema_version := 1;

  insert into audit_chain_heads (org_id, last_sequence, last_hash)
  values (new.org_id, 0, null)
  on conflict (org_id) do nothing;

  select * into strict head
  from audit_chain_heads
  where org_id = new.org_id
  for update;

  new.sequence := head.last_sequence + 1;
  new.prev_hash := head.last_hash;
  new.this_hash := helix_audit_event_hash(
    new.schema_version,
    new.org_id,
    new.id,
    new.sequence,
    new.actor_id,
    new.verb,
    new.object_type,
    new.object_id,
    new.trace_id,
    new.payload,
    new.created_at,
    new.prev_hash
  );

  update audit_chain_heads
  set last_sequence = new.sequence, last_hash = new.this_hash
  where org_id = new.org_id;
  return new;
end
$$;

create trigger activity_chain_integrity
before insert on activity
for each row execute function helix_chain_activity();

-- The verifier and immutable-shipping workers must cross tenant boundaries, but
-- the runtime role must never receive BYPASSRLS. Keep that privilege inside
-- three read-only, fixed-query entry points owned by the migration role.
create or replace function helix_list_audit_org_ids()
returns table (org_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select distinct activity.org_id
  from activity
  order by activity.org_id
$$;

create or replace function helix_list_audit_shipping_records(
  input_after_created_at timestamptz,
  input_after_id uuid,
  input_limit integer
)
returns table (
  id uuid,
  org_id uuid,
  actor_id uuid,
  verb text,
  object_type text,
  object_id uuid,
  trace_id text,
  payload jsonb,
  prev_hash text,
  this_hash text,
  created_at timestamptz,
  schema_version integer,
  sequence text
)
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select
    event.id,
    event.org_id,
    event.actor_id,
    event.verb,
    event.object_type,
    event.object_id,
    event.trace_id,
    event.payload,
    event.prev_hash,
    event.this_hash,
    event.created_at,
    event.schema_version,
    event.sequence::text
  from activity event
  where input_limit between 1 and 10000
    and (
      input_after_created_at is null
      or (event.created_at, event.id) > (input_after_created_at, input_after_id)
    )
  order by event.created_at, event.id
  limit input_limit
$$;

create or replace function helix_get_audit_shipping_backlog(
  input_after_created_at timestamptz,
  input_after_id uuid
)
returns table (record_count bigint, oldest_created_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select count(*), min(event.created_at)
  from activity event
  where input_after_created_at is null
    or (event.created_at, event.id) > (input_after_created_at, input_after_id)
$$;

alter table audit_chain_heads owner to helix_migration_owner;
alter function helix_canonical_jsonb(jsonb) owner to helix_migration_owner;
alter function helix_audit_event_hash(integer, uuid, uuid, bigint, uuid, text, text, uuid, text, jsonb, timestamptz, text) owner to helix_migration_owner;
alter function helix_chain_activity() owner to helix_migration_owner;
alter function helix_list_audit_org_ids() owner to helix_migration_owner;
alter function helix_list_audit_shipping_records(timestamptz, uuid, integer) owner to helix_migration_owner;
alter function helix_get_audit_shipping_backlog(timestamptz, uuid) owner to helix_migration_owner;

revoke all on audit_chain_heads from public, helix_app, helix_worker, helix_readonly;
grant select on audit_chain_heads to helix_app, helix_worker, helix_readonly;
revoke update, delete on activity from helix_app, helix_worker;
revoke all on function helix_canonical_jsonb(jsonb) from public;
revoke all on function helix_audit_event_hash(integer, uuid, uuid, bigint, uuid, text, text, uuid, text, jsonb, timestamptz, text) from public;
revoke all on function helix_chain_activity() from public;
revoke all on function helix_list_audit_org_ids() from public;
revoke all on function helix_list_audit_shipping_records(timestamptz, uuid, integer) from public;
revoke all on function helix_get_audit_shipping_backlog(timestamptz, uuid) from public;
grant execute on function helix_canonical_jsonb(jsonb) to helix_app, helix_worker, helix_readonly;
grant execute on function helix_audit_event_hash(integer, uuid, uuid, bigint, uuid, text, text, uuid, text, jsonb, timestamptz, text) to helix_app, helix_worker, helix_readonly;
grant execute on function helix_list_audit_org_ids(),
  helix_list_audit_shipping_records(timestamptz, uuid, integer),
  helix_get_audit_shipping_backlog(timestamptz, uuid) to helix_app, helix_worker;
