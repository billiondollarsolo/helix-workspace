-- Any durable access mutation advances the room ACL version and emits an
-- ordered room event. The transactional outbox then reaches every replica,
-- including when the process that changed access exits before publishing.

create or replace function emit_chat_acl_change(
  target_org_id uuid,
  target_room_id uuid,
  target_actor_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
declare
  next_acl_version bigint;
begin
  update public.chat_room_settings settings
  set acl_version = settings.acl_version + 1
  where settings.org_id = target_org_id
    and settings.thread_id = target_room_id
    and exists (
      select 1 from public.threads room
      where room.org_id = settings.org_id
        and room.id = settings.thread_id
        and room.kind in ('chat_room', 'chat_dm')
    )
  returning acl_version into next_acl_version;

  if found then
    perform public.append_chat_room_event(
      target_org_id,
      target_room_id,
      jsonb_build_object(
        'type', 'access.changed',
        'actorId', target_actor_id,
        'aclVersion', next_acl_version
      )
    );
  end if;
end
$$;

create or replace function chat_permission_acl_event()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  old_is_chat boolean := false;
  new_is_chat boolean := false;
begin
  if tg_op <> 'INSERT' and old.resource_type = 'thread' then
    select exists (
      select 1 from public.threads room
      where room.org_id = old.org_id
        and room.id = old.resource_id
        and room.kind in ('chat_room', 'chat_dm')
    ) into old_is_chat;
  end if;
  if tg_op <> 'DELETE' and new.resource_type = 'thread' then
    select exists (
      select 1 from public.threads room
      where room.org_id = new.org_id
        and room.id = new.resource_id
        and room.kind in ('chat_room', 'chat_dm')
    ) into new_is_chat;
  end if;

  if tg_op = 'UPDATE'
    and old.org_id = new.org_id
    and old.resource_type = new.resource_type
    and old.resource_id = new.resource_id
    and old.actor_id = new.actor_id then
    if new_is_chat then
      perform public.emit_chat_acl_change(new.org_id, new.resource_id, new.actor_id);
    end if;
    return new;
  end if;

  if old_is_chat then
    perform public.emit_chat_acl_change(old.org_id, old.resource_id, old.actor_id);
  end if;
  if new_is_chat then
    perform public.emit_chat_acl_change(new.org_id, new.resource_id, new.actor_id);
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

drop trigger if exists permissions_emit_chat_acl_event on permissions;
create trigger permissions_emit_chat_acl_event
after insert or update or delete on permissions
for each row execute function chat_permission_acl_event();

create or replace function actor_chat_acl_event()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  grant_row record;
begin
  if old.disabled_at is not distinct from new.disabled_at then
    return new;
  end if;
  for grant_row in
    select distinct permission.org_id, permission.resource_id
    from public.permissions permission
    join public.threads room
      on room.org_id = permission.org_id
      and room.id = permission.resource_id
      and room.kind in ('chat_room', 'chat_dm')
    where permission.org_id = new.org_id
      and permission.actor_id = new.id
      and permission.resource_type = 'thread'
  loop
    perform public.emit_chat_acl_change(grant_row.org_id, grant_row.resource_id, new.id);
  end loop;
  return new;
end
$$;

drop trigger if exists actors_emit_chat_acl_event on actors;
create trigger actors_emit_chat_acl_event
after update of disabled_at on actors
for each row execute function actor_chat_acl_event();

-- Identity suspension is part of Chat authorization as soon as the identity
-- layer exists; keeping it in the one predicate makes every read/write and
-- replay path agree.
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
        and (
          subject.type <> 'user'
          or exists (
            select 1
            from organization_memberships membership
            join identity_subjects identity on identity.id = membership.subject_id
            where membership.org_id = subject.org_id
              and membership.actor_id = subject.id
              and membership.status = 'active'
              and identity.status = 'active'
          )
        )
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

create or replace function organization_membership_chat_acl_event()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  grant_row record;
  target_org_id uuid;
  target_actor_id uuid;
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;
  target_org_id := case when tg_op = 'DELETE' then old.org_id else new.org_id end;
  target_actor_id := case when tg_op = 'DELETE' then old.actor_id else new.actor_id end;
  for grant_row in
    select distinct permission.org_id, permission.resource_id
    from public.permissions permission
    join public.threads room
      on room.org_id = permission.org_id
      and room.id = permission.resource_id
      and room.kind in ('chat_room', 'chat_dm')
    where permission.org_id = target_org_id
      and permission.actor_id = target_actor_id
      and permission.resource_type = 'thread'
  loop
    perform public.emit_chat_acl_change(
      grant_row.org_id,
      grant_row.resource_id,
      target_actor_id
    );
  end loop;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

drop trigger if exists organization_memberships_emit_chat_acl_event
  on organization_memberships;
create trigger organization_memberships_emit_chat_acl_event
after update of status or delete on organization_memberships
for each row execute function organization_membership_chat_acl_event();

create or replace function identity_subject_chat_acl_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  grant_row record;
begin
  if old.status is not distinct from new.status then
    return new;
  end if;
  for grant_row in
    select distinct membership.org_id, membership.actor_id, permission.resource_id
    from public.organization_memberships membership
    join public.permissions permission
      on permission.org_id = membership.org_id
      and permission.actor_id = membership.actor_id
      and permission.resource_type = 'thread'
    join public.threads room
      on room.org_id = permission.org_id
      and room.id = permission.resource_id
      and room.kind in ('chat_room', 'chat_dm')
    where membership.subject_id = new.id
  loop
    perform public.emit_chat_acl_change(
      grant_row.org_id,
      grant_row.resource_id,
      grant_row.actor_id
    );
  end loop;
  return new;
end
$$;

drop trigger if exists identity_subjects_emit_chat_acl_event on identity_subjects;
create trigger identity_subjects_emit_chat_acl_event
after update of status on identity_subjects
for each row execute function identity_subject_chat_acl_event();
