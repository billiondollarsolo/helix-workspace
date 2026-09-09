-- Chat authorization is one predicate over a tenant-correct, time-bounded,
-- non-revoked grant. Invalid rows can never become effective by accident.

alter table permissions
  add column if not exists status text not null default 'active',
  add column if not exists valid_from timestamptz,
  add column if not exists revoked_at timestamptz,
  add column if not exists revocation_epoch bigint not null default 0;

update permissions
set valid_from = case
  when expires_at is not null and expires_at <= created_at
    then expires_at - interval '1 microsecond'
  else created_at
end
where valid_from is null;

alter table permissions
  alter column valid_from set default now(),
  alter column valid_from set not null;

-- Invalid cross-tenant grants are security defects, not data to preserve.
delete from permissions permission
where not exists (
    select 1 from actors subject
    where subject.org_id = permission.org_id and subject.id = permission.actor_id
  )
  or (
    permission.granted_by_actor_id is not null
    and not exists (
      select 1 from actors grantor
      where grantor.org_id = permission.org_id
        and grantor.id = permission.granted_by_actor_id
    )
  )
  or (
    permission.resource_type = 'thread'
    and (
      not exists (
        select 1 from threads room
        where room.org_id = permission.org_id
          and room.id = permission.resource_id
      )
      or (
        exists (
          select 1 from threads room
          where room.org_id = permission.org_id
            and room.id = permission.resource_id
            and room.kind in ('chat_room', 'chat_dm')
        )
        and (
          permission.granted_by_actor_id is null
          or permission.role not in ('owner', 'moderator', 'member')
        )
      )
    )
  );

alter table permissions
  drop constraint if exists permissions_actor_id_fkey,
  drop constraint if exists permissions_granted_by_actor_id_fkey;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'permissions_subject_org_fk'
  ) then
    alter table permissions
      add constraint permissions_subject_org_fk
      foreign key (org_id, actor_id) references actors (org_id, id) on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'permissions_grantor_org_fk'
  ) then
    alter table permissions
      add constraint permissions_grantor_org_fk
      foreign key (org_id, granted_by_actor_id) references actors (org_id, id);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'permissions_status_check'
  ) then
    alter table permissions
      add constraint permissions_status_check check (status in ('active', 'revoked'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'permissions_valid_window_check'
  ) then
    alter table permissions
      add constraint permissions_valid_window_check
      check (expires_at is null or expires_at > valid_from);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'permissions_revocation_state_check'
  ) then
    alter table permissions
      add constraint permissions_revocation_state_check check (
        (status = 'active' and revoked_at is null and revocation_epoch = 0)
        or
        (status = 'revoked' and revoked_at is not null and revocation_epoch > 0)
      );
  end if;
end
$$;

create or replace function require_valid_chat_permission_scope()
returns trigger
language plpgsql
as $$
declare
  resource_kind thread_kind;
begin
  if new.resource_type <> 'thread' then
    return new;
  end if;
  select room.kind into resource_kind
  from threads room
  where room.org_id = new.org_id
    and room.id = new.resource_id;
  if resource_kind is null then
    raise foreign_key_violation using
      constraint = 'permissions_thread_org_fk',
      message = 'thread permissions require a resource in the same organization';
  end if;
  if resource_kind in ('chat_room', 'chat_dm') and (
      new.granted_by_actor_id is null
      or new.role not in ('owner', 'moderator', 'member')
    ) then
    raise check_violation using
      constraint = 'permissions_chat_scope_check',
      message = 'chat permissions require a grantor and a closed chat role';
  end if;
  return new;
end
$$;

drop trigger if exists permissions_require_valid_chat_scope on permissions;
create trigger permissions_require_valid_chat_scope
before insert or update of org_id, resource_type, resource_id, role, granted_by_actor_id
on permissions
for each row execute function require_valid_chat_permission_scope();

create or replace function chat_permission_is_valid(
  grant_row permissions,
  expected_org_id uuid,
  expected_actor_id uuid,
  expected_room_id uuid
)
returns boolean
language sql
stable
parallel safe
as $$
  select
    grant_row.org_id = expected_org_id
    and grant_row.actor_id = expected_actor_id
    and grant_row.resource_type = 'thread'
    and grant_row.resource_id = expected_room_id
    and grant_row.role in ('owner', 'moderator', 'member')
    and grant_row.status = 'active'
    and grant_row.valid_from <= statement_timestamp()
    and (grant_row.expires_at is null or grant_row.expires_at > statement_timestamp())
    and grant_row.revoked_at is null
    and grant_row.revocation_epoch = 0
    and exists (
      select 1 from actors subject
      where subject.org_id = grant_row.org_id
        and subject.id = grant_row.actor_id
        and subject.disabled_at is null
    )
    and exists (
      select 1 from actors grantor
      where grantor.org_id = grant_row.org_id
        and grantor.id = grant_row.granted_by_actor_id
    )
    and exists (
      select 1 from threads room
      where room.org_id = grant_row.org_id
        and room.id = grant_row.resource_id
        and room.kind in ('chat_room', 'chat_dm')
    )
$$;

create index if not exists permissions_chat_validity_idx
  on permissions (org_id, actor_id, resource_id)
  where resource_type = 'thread' and status = 'active';
