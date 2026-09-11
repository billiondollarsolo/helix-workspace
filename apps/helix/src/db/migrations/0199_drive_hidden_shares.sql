-- Private "remove from Shared with me" hides, plus access requests that do not
-- require the requester to already read the file.

create table drive_hidden_shares (
  org_id uuid not null,
  actor_id uuid not null,
  resource_type text not null check (resource_type in ('object', 'drive_folder')),
  resource_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (org_id, actor_id, resource_type, resource_id),
  foreign key (org_id, actor_id) references actors (org_id, id) on delete cascade
);

create table drive_access_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  resource_type text not null check (resource_type in ('object', 'drive_folder')),
  resource_id uuid not null,
  requester_actor_id uuid not null,
  owner_actor_id uuid not null,
  message text,
  state text not null default 'open' check (state in ('open', 'approved', 'rejected')),
  created_at timestamptz not null default statement_timestamp(),
  decided_at timestamptz,
  unique (org_id, resource_type, resource_id, requester_actor_id),
  foreign key (org_id, requester_actor_id) references actors (org_id, id) on delete cascade,
  foreign key (org_id, owner_actor_id) references actors (org_id, id) on delete restrict,
  check (
    (state = 'open' and decided_at is null)
    or (state <> 'open' and decided_at is not null)
  )
);

create index drive_access_requests_owner_idx
  on drive_access_requests (org_id, owner_actor_id, state, created_at desc);

alter table drive_hidden_shares enable row level security;
alter table drive_hidden_shares force row level security;
create policy helix_tenant_isolation on drive_hidden_shares
  using (org_id = helix_current_org_id() and actor_id = helix_current_actor_id())
  with check (org_id = helix_current_org_id() and actor_id = helix_current_actor_id());

alter table drive_access_requests enable row level security;
alter table drive_access_requests force row level security;
create policy helix_tenant_isolation on drive_access_requests
  using (
    org_id = helix_current_org_id()
    and (
      requester_actor_id = helix_current_actor_id()
      or owner_actor_id = helix_current_actor_id()
    )
  )
  with check (
    org_id = helix_current_org_id()
    and requester_actor_id = helix_current_actor_id()
  );

create function helix_drive_request_access(
  input_org_id uuid,
  input_actor_id uuid,
  input_resource_type text,
  input_resource_id uuid,
  input_message text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare owner_id uuid;
declare request_id uuid;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
  then raise insufficient_privilege using message = 'Access request requires the current actor';
  end if;
  if input_resource_type = 'object' then
    select owner_actor_id into owner_id
    from objects
    where org_id = input_org_id and id = input_resource_id and deleted_at is null;
  else
    select owner_actor_id into owner_id
    from drive_folders
    where org_id = input_org_id and id = input_resource_id and deleted_at is null;
  end if;
  if owner_id is null then
    raise foreign_key_violation using message = 'Unknown Drive resource';
  end if;
  if owner_id = input_actor_id then
    raise check_violation using message = 'Owners do not request access to their own files';
  end if;
  if helix_drive_effective_role(
    input_org_id, input_actor_id, input_resource_type, input_resource_id
  ) is not null then
    raise check_violation using message = 'Actor already has access';
  end if;
  insert into drive_access_requests (
    org_id, resource_type, resource_id, requester_actor_id, owner_actor_id, message
  ) values (
    input_org_id, input_resource_type, input_resource_id, input_actor_id, owner_id, input_message
  )
  on conflict (org_id, resource_type, resource_id, requester_actor_id)
  do update set
    message = excluded.message,
    state = 'open',
    decided_at = null
  where drive_access_requests.state <> 'open'
  returning id into request_id;
  if request_id is null then
    select id into request_id from drive_access_requests
    where org_id = input_org_id
      and resource_type = input_resource_type
      and resource_id = input_resource_id
      and requester_actor_id = input_actor_id;
  end if;
  return request_id;
end
$$;

create function helix_drive_decide_access_request(
  input_org_id uuid,
  input_actor_id uuid,
  input_request_id uuid,
  input_approve boolean
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare request drive_access_requests%rowtype;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
  then raise insufficient_privilege using message = 'Access decision requires the current actor';
  end if;
  select * into request from drive_access_requests
  where org_id = input_org_id and id = input_request_id;
  if request.id is null then
    raise foreign_key_violation using message = 'Unknown access request';
  end if;
  if request.owner_actor_id is distinct from input_actor_id then
    raise insufficient_privilege using message = 'Only the owner can decide an access request';
  end if;
  if request.state <> 'open' then
    raise check_violation using message = 'Access request is no longer open';
  end if;
  if input_approve then
    insert into permissions (
      org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
    ) values (
      input_org_id, request.requester_actor_id, request.resource_type, request.resource_id,
      'reader', input_actor_id
    ) on conflict do nothing;
  end if;
  update drive_access_requests
  set state = case when input_approve then 'approved' else 'rejected' end,
      decided_at = statement_timestamp()
  where id = request.id;
  return request.requester_actor_id;
end
$$;

alter table drive_hidden_shares owner to helix_migration_owner;
alter table drive_access_requests owner to helix_migration_owner;
alter function helix_drive_request_access(uuid, uuid, text, uuid, text) owner to helix_migration_owner;
alter function helix_drive_decide_access_request(uuid, uuid, uuid, boolean) owner to helix_migration_owner;

revoke all on drive_hidden_shares, drive_access_requests from public;
grant select, insert, delete on drive_hidden_shares to helix_app;
grant select, insert, update on drive_access_requests to helix_app;
revoke execute on function helix_drive_request_access(uuid, uuid, text, uuid, text) from public;
revoke execute on function helix_drive_decide_access_request(uuid, uuid, uuid, boolean) from public;
grant execute on function helix_drive_request_access(uuid, uuid, text, uuid, text) to helix_app;
grant execute on function helix_drive_decide_access_request(uuid, uuid, uuid, boolean) to helix_app;
