alter table drive_share_links
  add column if not exists token_hash text,
  add column if not exists password_hash text,
  add column if not exists one_time boolean not null default false,
  add column if not exists allowed_domains text[] not null default '{}',
  add column if not exists allow_download boolean not null default true,
  add column if not exists consumed_at timestamptz,
  add column if not exists access_count bigint not null default 0,
  add column if not exists last_access_at timestamptz,
  add column if not exists classification text not null default 'standard';

-- Earlier releases stored the digest as bytea and already destroyed raw tokens.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
    and table_name = 'drive_share_links' and column_name = 'token_hash' and data_type = 'bytea') then
    alter table drive_share_links alter column token_hash type text using encode(token_hash, 'hex');
  end if;
end;
$$;

update drive_share_links link
set token_hash = coalesce(link.token_hash, encode(digest(link.token, 'sha256'), 'hex')),
    role = 'reader',
    classification = coalesce((
      select classification.classification
      from resource_classifications classification
      where classification.org_id = link.org_id
        and classification.resource_type in ('drive.file', 'object')
        and classification.resource_id = link.object_id::text
      order by case classification.resource_type when 'drive.file' then 0 else 1 end
      limit 1
    ), 'standard');

create function helix_valid_share_domains(input_domains text[])
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select cardinality(input_domains) <= 50 and not exists (
    select 1 from unnest(input_domains) domain
    where domain <> lower(domain)
      or domain !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:[.][a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
  )
$$;

alter table drive_share_links
  alter column token_hash set not null,
  drop constraint drive_share_links_role_check,
  add constraint drive_share_links_role_reader_only check (role = 'reader'),
  add constraint drive_share_links_token_hash_check check (token_hash ~ '^[a-f0-9]{64}$'),
  add constraint drive_share_links_password_hash_check check (
    password_hash is null or password_hash like '$argon2id$%'
  ),
  add constraint drive_share_links_domain_check check (helix_valid_share_domains(allowed_domains)),
  add constraint drive_share_links_consumed_shape check (not one_time or consumed_at is null or consumed_at >= created_at),
  add constraint drive_share_links_access_count_check check (access_count >= 0),
  drop column token;

create unique index if not exists drive_share_links_token_hash_idx on drive_share_links (token_hash);
create unique index drive_share_links_org_id_id_idx on drive_share_links (org_id, id);

create function helix_drive_share_link_by_token_hash(input_token_hash text)
returns setof drive_share_links
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select link.*
  from public.drive_share_links link
  where link.token_hash = input_token_hash
  limit 1
$$;

create table drive_share_link_rate_limits (
  scope_hash text primary key check (scope_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now()
);

create index drive_share_link_rate_limits_updated_idx
  on drive_share_link_rate_limits (updated_at);

create function helix_consume_drive_share_rate_limit(
  input_scope_hash text,
  input_limit integer,
  input_window_seconds integer default 60
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  current_count integer;
begin
  if input_scope_hash !~ '^[a-f0-9]{64}$'
    or input_limit < 1 or input_window_seconds < 1 or input_window_seconds > 3600
  then raise invalid_parameter_value; end if;
  insert into public.drive_share_link_rate_limits (
    scope_hash, window_started_at, request_count, updated_at
  ) values (input_scope_hash, statement_timestamp(), 1, statement_timestamp())
  on conflict (scope_hash) do update set
    window_started_at = case
      when drive_share_link_rate_limits.window_started_at
        <= statement_timestamp() - make_interval(secs => input_window_seconds)
      then statement_timestamp() else drive_share_link_rate_limits.window_started_at end,
    request_count = case
      when drive_share_link_rate_limits.window_started_at
        <= statement_timestamp() - make_interval(secs => input_window_seconds)
      then 1 else drive_share_link_rate_limits.request_count + 1 end,
    updated_at = statement_timestamp()
  returning request_count into current_count;
  return current_count <= input_limit;
end
$$;

create table drive_share_link_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  link_id uuid not null,
  event_type text not null check (event_type in ('create', 'access', 'download', 'revoke')),
  outcome text not null check (outcome in ('allowed', 'denied', 'integrity_error')),
  actor_id uuid,
  client_key text check (client_key is null or client_key ~ '^[a-f0-9]{64}$'),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (org_id, link_id) references drive_share_links(org_id, id) on delete restrict,
  foreign key (org_id, actor_id) references actors(org_id, id) on delete restrict
);

create index drive_share_link_events_link_idx
  on drive_share_link_events (org_id, link_id, created_at, id);

create function helix_append_drive_share_link_event(
  input_org_id uuid,
  input_link_id uuid,
  input_event_type text,
  input_outcome text,
  input_actor_id uuid,
  input_client_key text,
  input_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1 from public.drive_share_links link
    where link.org_id = input_org_id and link.id = input_link_id
  ) then raise foreign_key_violation; end if;
  insert into public.drive_share_link_events (
    org_id, link_id, event_type, outcome, actor_id, client_key, details
  ) values (
    input_org_id, input_link_id, input_event_type, input_outcome,
    input_actor_id, input_client_key, coalesce(input_details, '{}'::jsonb)
  );
end
$$;

create function helix_drive_share_link_events_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise insufficient_privilege using message = 'Drive share-link events are immutable';
end
$$;

create trigger drive_share_link_events_no_update_or_delete
before update or delete on drive_share_link_events
for each row execute function helix_drive_share_link_events_immutable();

alter table drive_share_link_rate_limits enable row level security;
alter table drive_share_link_rate_limits force row level security;
alter table drive_share_link_events enable row level security;
alter table drive_share_link_events force row level security;

create policy drive_share_link_events_tenant_read on drive_share_link_events for select
  using (org_id = helix_current_org_id());

alter function helix_consume_drive_share_rate_limit(text, integer, integer)
  owner to helix_migration_owner;
alter function helix_drive_share_link_by_token_hash(text) owner to helix_migration_owner;
alter function helix_append_drive_share_link_event(uuid, uuid, text, text, uuid, text, jsonb)
  owner to helix_migration_owner;
alter function helix_drive_share_link_events_immutable() owner to helix_migration_owner;
alter function helix_valid_share_domains(text[]) owner to helix_migration_owner;

revoke all on drive_share_link_rate_limits, drive_share_link_events from public;
revoke all on function helix_consume_drive_share_rate_limit(text, integer, integer) from public;
revoke all on function helix_drive_share_link_by_token_hash(text) from public;
revoke all on function helix_append_drive_share_link_event(uuid, uuid, text, text, uuid, text, jsonb) from public;
revoke all on function helix_valid_share_domains(text[]) from public;
grant execute on function helix_consume_drive_share_rate_limit(text, integer, integer) to helix_app;
grant execute on function helix_drive_share_link_by_token_hash(text) to helix_app;
grant execute on function helix_append_drive_share_link_event(uuid, uuid, text, text, uuid, text, jsonb) to helix_app;
grant execute on function helix_valid_share_domains(text[]) to helix_app, helix_worker;
grant select on drive_share_link_events to helix_app, helix_readonly;
