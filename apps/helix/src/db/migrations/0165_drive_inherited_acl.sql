-- One authoritative Drive ACL evaluator. Direct user/guest grants stay in
-- permissions, IAM groups stay canonical in directory_group_resource_grants,
-- and bearer links stay in the hardened drive_share_links capability model.

create table drive_shared_drives (
  id uuid primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  root_folder_id uuid not null references drive_folders(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 255),
  created_by_actor_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  unique (org_id, id),
  unique (org_id, root_folder_id),
  foreign key (org_id, created_by_actor_id) references actors(org_id, id)
);

create table drive_domain_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  resource_type text not null check (resource_type in ('object', 'drive_folder')),
  resource_id uuid not null,
  domain text not null check (
    domain = lower(domain)
    and domain ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:[.][a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  role text not null check (role in ('reader', 'commenter', 'editor', 'owner')),
  granted_by_actor_id uuid not null,
  expires_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (org_id, resource_type, resource_id, domain),
  foreign key (org_id, granted_by_actor_id) references actors(org_id, id),
  check (expires_at is null or expires_at > created_at)
);

-- An exception on a descendant suppresses inherited grants above that node;
-- an explicit grant on the same node can still restore access.
create table drive_acl_exceptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  resource_type text not null check (resource_type in ('object', 'drive_folder')),
  resource_id uuid not null,
  principal_type text not null check (principal_type in ('actor', 'group', 'domain')),
  principal_id uuid,
  domain text,
  created_by_actor_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  unique nulls not distinct (org_id, resource_type, resource_id, principal_type, principal_id, domain),
  foreign key (org_id, created_by_actor_id) references actors(org_id, id),
  check (
    (principal_type in ('actor', 'group') and principal_id is not null and domain is null)
    or (principal_type = 'domain' and principal_id is null and domain is not null
      and domain = lower(domain)
      and domain ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:[.][a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$')
  )
);

create index drive_domain_grants_resource_idx
  on drive_domain_grants(org_id, resource_type, resource_id);
create index drive_acl_exceptions_resource_idx
  on drive_acl_exceptions(org_id, resource_type, resource_id);

create function helix_drive_shared_drive_id(input_org_id uuid, input_folder_id uuid)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  with recursive ancestors(id, path) as (
    select input_folder_id, array[input_folder_id] where input_folder_id is not null
    union all
    select folder.parent_folder_id, ancestors.path || folder.parent_folder_id
    from drive_folders folder join ancestors on folder.id = ancestors.id
    where folder.org_id = input_org_id and folder.parent_folder_id is not null
      and not folder.parent_folder_id = any(ancestors.path)
  )
  select drive.id
  from drive_shared_drives drive join ancestors on ancestors.id = drive.root_folder_id
  where drive.org_id = input_org_id limit 1
$$;

-- Shared-drive content belongs to the organization, never to an individual.
-- Keep that invariant at the write boundary so every uploader/editor gets the
-- same behavior without duplicating ownership logic in each application path.
create function helix_drive_normalize_object_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare
  folder_id uuid;
begin
  if coalesce(new.metadata->>'folderId', '') ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    folder_id := (new.metadata->>'folderId')::uuid;
  end if;
  if helix_drive_shared_drive_id(new.org_id, folder_id) is not null then
    new.owner_actor_id := null;
  end if;
  return new;
end
$$;

create function helix_drive_normalize_folder_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if helix_drive_shared_drive_id(new.org_id, new.parent_folder_id) is not null then
    new.owner_actor_id := null;
  end if;
  return new;
end
$$;

create trigger drive_objects_shared_owner
before insert or update of owner_actor_id, metadata on objects
for each row execute function helix_drive_normalize_object_owner();

create trigger drive_folders_shared_owner
before insert or update of owner_actor_id, parent_folder_id on drive_folders
for each row execute function helix_drive_normalize_folder_owner();

-- IAM-17 originally covered object grants only. Folder grants use the same
-- group graph and materialization transaction, with Drive's canonical roles.
alter table directory_group_resource_grants
  drop constraint directory_group_resource_grants_resource_type_check,
  add constraint directory_group_resource_grants_resource_type_check
    check (resource_type in ('object', 'drive_folder', 'thread', 'calendar'));

create or replace function helix_validate_directory_group_grant()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.resource_type = 'object' then
    if new.role not in ('reader', 'commenter', 'editor', 'owner') or not exists (
      select 1 from objects where org_id = new.org_id and id = new.resource_id and deleted_at is null
    ) then raise check_violation using message = 'invalid Drive group grant'; end if;
  elsif new.resource_type = 'drive_folder' then
    if new.role not in ('reader', 'commenter', 'editor', 'owner') or not exists (
      select 1 from drive_folders where org_id = new.org_id and id = new.resource_id and deleted_at is null
    ) then raise check_violation using message = 'invalid Drive folder group grant'; end if;
  elsif new.resource_type = 'thread' then
    if new.role not in ('member', 'moderator') or not exists (
      select 1 from threads where org_id = new.org_id and id = new.resource_id
        and kind = 'chat_room' and archived_at is null
    ) then raise check_violation using message = 'invalid Chat group grant'; end if;
  elsif new.resource_type = 'calendar' then
    if new.expires_at is not null or new.role not in ('reader', 'writer') or not exists (
      select 1 from cal_calendars where org_id = new.org_id and id = new.resource_id and deleted_at is null
    ) then raise check_violation using message = 'invalid Calendar group grant'; end if;
  end if;
  return new;
end
$$;

update directory_group_resource_grants set role = 'reader'
where resource_type = 'object' and role = 'viewer';
update permissions set role = 'reader'
where source_group_grant_id is not null and resource_type = 'object' and role = 'viewer';

create function helix_drive_effective_role(
  input_org_id uuid, input_actor_id uuid, input_resource_type text, input_resource_id uuid
)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  with recursive actor_context as (
    select actor.id, lower(split_part(actor.email, '@', 2)) as domain,
      coalesce(membership.guest_type <> 'member', false) as external,
      case when coalesce(membership.guest_type <> 'member', false) then exists (
        select 1 from admin_security_policies policy
        where policy.org_id = input_org_id and policy.policy_type = 'external_sharing'
          and policy.enabled and policy.enforcement <> 'disabled'
          and (policy.settings->>'mode' = 'anyone' or (
            policy.settings->>'mode' = 'allowlist' and exists (
              select 1 from jsonb_array_elements_text(
                coalesce(policy.settings->'allowedDomains', '[]'::jsonb)
              ) allowed(domain)
              where lower(allowed.domain) = lower(split_part(actor.email, '@', 2))
            )
          ))
      ) else true end as allowed,
      coalesce(membership.guest_type <> 'member', false) and exists (
        select 1 from admin_security_policies policy
        where policy.org_id = input_org_id and policy.policy_type = 'external_sharing'
          and policy.enabled and policy.enforcement <> 'disabled'
          and coalesce((policy.settings->>'requireExpiry')::boolean, false)
      ) as requires_expiry
    from actors actor
    left join organization_memberships membership
      on membership.org_id = actor.org_id and membership.actor_id = actor.id
    where actor.org_id = input_org_id and actor.id = input_actor_id
      and actor.disabled_at is null
      and (actor.type <> 'user' or membership.status = 'active')
  ), target as (
    select object.id, object.owner_actor_id,
      nullif(object.metadata->>'folderId', '')::uuid as folder_id
    from objects object
    where input_resource_type = 'object' and object.org_id = input_org_id
      and object.id = input_resource_id
    union all
    select folder.id, folder.owner_actor_id, folder.id
    from drive_folders folder
    where input_resource_type = 'drive_folder' and folder.org_id = input_org_id
      and folder.id = input_resource_id
  ), folders(id, parent_folder_id, owner_actor_id, depth, path) as (
    select folder.id, folder.parent_folder_id, folder.owner_actor_id,
      case when input_resource_type = 'object' then 1 else 0 end,
      array[folder.id]
    from drive_folders folder join target on folder.id = target.folder_id
    where folder.org_id = input_org_id
    union all
    select parent.id, parent.parent_folder_id, parent.owner_actor_id,
      child.depth + 1, child.path || parent.id
    from drive_folders parent join folders child on child.parent_folder_id = parent.id
    where parent.org_id = input_org_id and not parent.id = any(child.path)
  ), nodes as (
    select input_resource_type as resource_type, target.id as resource_id,
      0 as depth, target.owner_actor_id from target
    union all
    select 'drive_folder', id, depth, owner_actor_id from folders
    where not (input_resource_type = 'drive_folder' and depth = 0)
  ), shared as (
    select drive.root_folder_id
    from drive_shared_drives drive join folders on folders.id = drive.root_folder_id
    where drive.org_id = input_org_id limit 1
  ), matching_exceptions as (
    select node.depth
    from drive_acl_exceptions exception join nodes node
      on node.resource_type = exception.resource_type and node.resource_id = exception.resource_id
    cross join actor_context actor
    where exception.org_id = input_org_id and (
      (exception.principal_type = 'actor' and exception.principal_id = input_actor_id)
      or (exception.principal_type = 'group' and helix_directory_group_contains(
        input_org_id, exception.principal_id, input_actor_id
      ))
      or (exception.principal_type = 'domain' and exception.domain = actor.domain)
    )
  ), candidates(role, depth) as (
    select 'owner', node.depth from nodes node
    cross join actor_context actor
    where actor.allowed and not actor.external
      and not exists (select 1 from shared) and node.owner_actor_id = input_actor_id
    union all
    select case when permission.role = 'owner' and exists (
      select 1 from shared where shared.root_folder_id <> node.resource_id
    ) then 'editor' else permission.role end, node.depth
    from nodes node join permissions permission
      on permission.org_id = input_org_id and permission.resource_type = node.resource_type
      and permission.resource_id = node.resource_id and permission.actor_id = input_actor_id
    cross join actor_context actor
    where actor.allowed and (not actor.requires_expiry or permission.expires_at is not null)
      and permission.status = 'active' and permission.revoked_at is null
      and permission.valid_from <= statement_timestamp()
      and (permission.expires_at is null or permission.expires_at > statement_timestamp())
    union all
    select case when grant_record.role = 'owner' and exists (
      select 1 from shared where shared.root_folder_id <> node.resource_id
    ) then 'editor' else grant_record.role end, node.depth
    from nodes node join directory_group_resource_grants grant_record
      on grant_record.org_id = input_org_id and grant_record.resource_type = node.resource_type
      and grant_record.resource_id = node.resource_id
    cross join actor_context actor
    where actor.allowed and (not actor.requires_expiry or grant_record.expires_at is not null)
      and helix_directory_group_contains(input_org_id, grant_record.group_id, input_actor_id)
      and (grant_record.expires_at is null or grant_record.expires_at > statement_timestamp())
    union all
    select case when grant_record.role = 'owner' and exists (
      select 1 from shared where shared.root_folder_id <> node.resource_id
    ) then 'editor' else grant_record.role end, node.depth
    from nodes node join drive_domain_grants grant_record
      on grant_record.org_id = input_org_id and grant_record.resource_type = node.resource_type
      and grant_record.resource_id = node.resource_id
    join actor_context actor on actor.domain = grant_record.domain
    where actor.allowed and (not actor.requires_expiry or grant_record.expires_at is not null)
      and (grant_record.expires_at is null or grant_record.expires_at > statement_timestamp())
  ), unblocked as (
    select role from candidates candidate
    where not exists (
      select 1 from matching_exceptions exception where exception.depth < candidate.depth
    )
  )
  select case max(case role
    when 'owner' then 3 when 'editor' then 2 when 'commenter' then 1 when 'reader' then 0
    else -1 end)
    when 3 then 'owner' when 2 then 'editor' when 1 then 'commenter' when 0 then 'reader'
    else null end
  from unblocked
  where exists (select 1 from actor_context)
$$;

create function helix_drive_visible_actor_ids(
  input_org_id uuid, input_resource_type text, input_resource_id uuid
)
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select coalesce(array_agg(actor.id order by actor.id), array[]::uuid[])
  from actors actor
  left join organization_memberships membership
    on membership.org_id = actor.org_id and membership.actor_id = actor.id
  where actor.org_id = input_org_id and actor.disabled_at is null
    and (actor.type <> 'user' or membership.status = 'active')
    and helix_drive_effective_role(input_org_id, actor.id, input_resource_type, input_resource_id) is not null
$$;

create function helix_set_drive_domain_grant(
  input_org_id uuid, input_actor_id uuid, input_resource_type text, input_resource_id uuid,
  input_domain text, input_role text, input_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare normalized_domain text := lower(btrim(input_domain)); grant_id uuid;
declare policy_mode text; allowed_domains jsonb; require_expiry boolean;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
    or helix_drive_effective_role(input_org_id, input_actor_id, input_resource_type, input_resource_id) <> 'owner'
  then raise insufficient_privilege using message = 'domain grant requires resource ownership'; end if;
  if not exists (
    select 1 from admin_domains where org_id = input_org_id and lower(domain) = normalized_domain
      and verification_status = 'verified'
  ) then
    select settings->>'mode', coalesce(settings->'allowedDomains', '[]'::jsonb),
      coalesce((settings->>'requireExpiry')::boolean, false)
    into policy_mode, allowed_domains, require_expiry
    from admin_security_policies where org_id = input_org_id and policy_type = 'external_sharing'
      and enabled and enforcement <> 'disabled';
    if policy_mode is null or policy_mode = 'blocked'
      or (policy_mode = 'allowlist' and not exists (
        select 1 from jsonb_array_elements_text(allowed_domains) allowed(domain)
        where lower(allowed.domain) = normalized_domain
      ))
    then raise insufficient_privilege using message = 'organization policy blocks this domain'; end if;
    if require_expiry and input_expires_at is null then
      raise check_violation using message = 'organization policy requires domain grant expiry';
    end if;
  end if;
  insert into drive_domain_grants(
    org_id, resource_type, resource_id, domain, role, granted_by_actor_id, expires_at
  ) values (
    input_org_id, input_resource_type, input_resource_id, normalized_domain,
    input_role, input_actor_id, input_expires_at
  ) on conflict (org_id, resource_type, resource_id, domain) do update set
    role = excluded.role, granted_by_actor_id = excluded.granted_by_actor_id,
    expires_at = excluded.expires_at, updated_at = statement_timestamp()
  returning id into grant_id;
  return grant_id;
end
$$;

create function helix_revoke_drive_domain_grant(
  input_org_id uuid, input_actor_id uuid, input_grant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare removed integer;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
    or not exists (
      select 1 from drive_domain_grants grant_record where grant_record.org_id = input_org_id
        and grant_record.id = input_grant_id
        and helix_drive_effective_role(input_org_id, input_actor_id,
          grant_record.resource_type, grant_record.resource_id) = 'owner'
    )
  then raise insufficient_privilege using message = 'domain grant revocation requires resource ownership'; end if;
  delete from drive_domain_grants where org_id = input_org_id and id = input_grant_id;
  get diagnostics removed = row_count;
  return removed = 1;
end
$$;

create function helix_set_drive_acl_exception(
  input_org_id uuid, input_actor_id uuid, input_resource_type text, input_resource_id uuid,
  input_principal_type text, input_principal_id uuid, input_domain text, input_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare normalized_domain text := case when input_domain is null then null else lower(btrim(input_domain)) end;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
    or helix_drive_effective_role(input_org_id, input_actor_id, input_resource_type, input_resource_id) <> 'owner'
  then raise insufficient_privilege using message = 'ACL exception requires resource ownership'; end if;
  if input_principal_type = 'actor' and not exists (
    select 1 from actors where org_id = input_org_id and id = input_principal_id
  ) then raise foreign_key_violation using message = 'ACL actor is not in this organization';
  elsif input_principal_type = 'group' and not exists (
    select 1 from admin_groups where org_id = input_org_id and id = input_principal_id
  ) then raise foreign_key_violation using message = 'ACL group is not in this organization'; end if;
  if input_enabled then
    insert into drive_acl_exceptions(
      org_id, resource_type, resource_id, principal_type, principal_id, domain, created_by_actor_id
    ) values (
      input_org_id, input_resource_type, input_resource_id, input_principal_type,
      input_principal_id, normalized_domain, input_actor_id
    ) on conflict do nothing;
  else
    delete from drive_acl_exceptions exception where exception.org_id = input_org_id
      and exception.resource_type = input_resource_type and exception.resource_id = input_resource_id
      and exception.principal_type = input_principal_type
      and exception.principal_id is not distinct from input_principal_id
      and exception.domain is not distinct from normalized_domain;
  end if;
end
$$;

create or replace function helix_grant_directory_group_resource(
  input_org_id uuid, input_actor_id uuid, input_group_id uuid, input_resource_type text,
  input_resource_id uuid, input_role text, input_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare new_id uuid; authorized boolean := false;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
  then raise insufficient_privilege using message = 'group grant context does not match actor'; end if;
  if not exists (select 1 from admin_groups where org_id = input_org_id and id = input_group_id)
  then raise foreign_key_violation using message = 'group is not in this organization'; end if;
  if input_resource_type in ('object', 'drive_folder') then
    authorized := helix_drive_effective_role(
      input_org_id, input_actor_id, input_resource_type, input_resource_id
    ) = 'owner';
  elsif input_resource_type = 'thread' then
    select exists (select 1 from permissions permission where chat_permission_is_valid(
      permission, input_org_id, input_actor_id, input_resource_id
    ) and permission.role = 'owner') into authorized;
  elsif input_resource_type = 'calendar' then
    select exists (
      select 1 from cal_calendars calendar where calendar.org_id = input_org_id
        and calendar.id = input_resource_id and calendar.deleted_at is null and (
          calendar.owner_actor_id = input_actor_id or exists (
            select 1 from cal_calendar_memberships membership
            where membership.org_id = input_org_id and membership.calendar_id = input_resource_id
              and membership.actor_id = input_actor_id and membership.role = 'owner'
          )
        )
    ) into authorized;
  end if;
  if not authorized then raise insufficient_privilege using message = 'actor cannot share this resource'; end if;
  insert into directory_group_resource_grants(
    org_id, group_id, resource_type, resource_id, role, granted_by_actor_id, expires_at
  ) values (
    input_org_id, input_group_id, input_resource_type, input_resource_id,
    input_role, input_actor_id, input_expires_at
  ) on conflict (org_id, group_id, resource_type, resource_id) do update set
    role = excluded.role, expires_at = excluded.expires_at,
    granted_by_actor_id = excluded.granted_by_actor_id, updated_at = statement_timestamp()
  returning id into new_id;
  return new_id;
end
$$;

create function helix_drive_create_shared_drive(
  input_org_id uuid, input_actor_id uuid, input_drive_id uuid, input_root_folder_id uuid, input_name text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
    or helix_drive_effective_role(input_org_id, input_actor_id, 'drive_folder', input_root_folder_id) <> 'owner'
  then raise insufficient_privilege using message = 'shared Drive creation requires folder ownership'; end if;
  if exists (
    with recursive ancestors as (
      select id, parent_folder_id, array[id] path from drive_folders
      where org_id = input_org_id and id = input_root_folder_id
      union all
      select parent.id, parent.parent_folder_id, ancestors.path || parent.id
      from drive_folders parent join ancestors on ancestors.parent_folder_id = parent.id
      where parent.org_id = input_org_id and not parent.id = any(ancestors.path)
    ) select 1 from drive_shared_drives drive join ancestors on ancestors.id = drive.root_folder_id
  ) then raise check_violation using message = 'shared Drives cannot be nested'; end if;

  insert into drive_shared_drives(id, org_id, root_folder_id, name, created_by_actor_id)
  select input_drive_id, input_org_id, input_root_folder_id,
    coalesce(nullif(btrim(input_name), ''), folder.name), input_actor_id
  from drive_folders folder where folder.org_id = input_org_id and folder.id = input_root_folder_id;
  insert into permissions(org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
  values (input_org_id, input_actor_id, 'drive_folder', input_root_folder_id, 'owner', input_actor_id)
  on conflict do nothing;
  with recursive descendants as (
    select id from drive_folders where org_id = input_org_id and id = input_root_folder_id
    union all
    select child.id from drive_folders child join descendants parent on child.parent_folder_id = parent.id
    where child.org_id = input_org_id
  )
  update drive_folders set owner_actor_id = null, updated_at = statement_timestamp()
  where org_id = input_org_id and id in (select id from descendants);
  with recursive descendants as (
    select id from drive_folders where org_id = input_org_id and id = input_root_folder_id
    union all
    select child.id from drive_folders child join descendants parent on child.parent_folder_id = parent.id
    where child.org_id = input_org_id
  )
  update objects set owner_actor_id = null, updated_at = statement_timestamp()
  where org_id = input_org_id
    and nullif(metadata->>'folderId', '')::uuid in (select id from descendants);
end
$$;

create function helix_drive_move_object(
  input_org_id uuid, input_actor_id uuid, input_object_id uuid, input_folder_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare source_drive uuid; destination_drive uuid;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
  then raise insufficient_privilege using message = 'Drive move context does not match actor'; end if;
  select drive.id into source_drive from drive_shared_drives drive
  where drive.org_id = input_org_id and drive.root_folder_id in (
    with recursive ancestors as (
      select nullif(metadata->>'folderId', '')::uuid id from objects
      where org_id = input_org_id and id = input_object_id
      union all select folder.parent_folder_id from drive_folders folder join ancestors on folder.id = ancestors.id
      where folder.org_id = input_org_id and folder.parent_folder_id is not null
    ) select id from ancestors
  );
  select drive.id into destination_drive from drive_shared_drives drive
  where input_folder_id is not null and drive.org_id = input_org_id and drive.root_folder_id in (
    with recursive ancestors as (
      select input_folder_id id
      union all select folder.parent_folder_id from drive_folders folder join ancestors on folder.id = ancestors.id
      where folder.org_id = input_org_id and folder.parent_folder_id is not null
    ) select id from ancestors
  );
  if source_drive is distinct from destination_drive then
    if helix_drive_effective_role(input_org_id, input_actor_id, 'object', input_object_id) is distinct from 'owner'
      or (input_folder_id is not null and helix_drive_effective_role(
        input_org_id, input_actor_id, 'drive_folder', input_folder_id
      ) is distinct from 'owner')
    then raise insufficient_privilege using message = 'ownership-boundary move requires manager access'; end if;
  elsif coalesce(helix_drive_effective_role(
      input_org_id, input_actor_id, 'object', input_object_id
    ), '') not in ('editor', 'owner')
    or (input_folder_id is not null and coalesce(helix_drive_effective_role(
      input_org_id, input_actor_id, 'drive_folder', input_folder_id
    ), '') not in ('commenter', 'editor', 'owner'))
  then raise insufficient_privilege using message = 'Drive move requires source and destination access'; end if;

  update objects set
    metadata = jsonb_set(metadata, '{folderId}', coalesce(to_jsonb(input_folder_id::text), 'null'::jsonb), true),
    owner_actor_id = case
      when destination_drive is not null then null
      when source_drive is not null then input_actor_id
      else owner_actor_id end,
    updated_at = statement_timestamp()
  where org_id = input_org_id and id = input_object_id and kind = 'file';
  if not found then raise no_data_found using message = 'Drive object was not found'; end if;
end
$$;

create function helix_drive_move_folder(
  input_org_id uuid, input_actor_id uuid, input_folder_id uuid, input_parent_folder_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare source_drive uuid; destination_drive uuid;
begin
  if helix_current_org_id() is distinct from input_org_id
    or helix_current_actor_id() is distinct from input_actor_id
  then raise insufficient_privilege using message = 'Drive move context does not match actor'; end if;
  if exists (
    select 1 from drive_shared_drives where org_id = input_org_id and root_folder_id = input_folder_id
  ) then raise check_violation using message = 'shared Drive roots cannot be moved'; end if;
  if input_parent_folder_id = input_folder_id or exists (
    with recursive descendants as (
      select id from drive_folders where org_id = input_org_id and parent_folder_id = input_folder_id
      union all
      select child.id from drive_folders child join descendants parent on child.parent_folder_id = parent.id
      where child.org_id = input_org_id
    ) select 1 from descendants where id = input_parent_folder_id
  ) then raise check_violation using message = 'Drive folders cannot contain themselves'; end if;
  source_drive := helix_drive_shared_drive_id(input_org_id, input_folder_id);
  destination_drive := helix_drive_shared_drive_id(input_org_id, input_parent_folder_id);
  if source_drive is distinct from destination_drive then
    if helix_drive_effective_role(
      input_org_id, input_actor_id, 'drive_folder', input_folder_id
    ) is distinct from 'owner' or (input_parent_folder_id is not null and helix_drive_effective_role(
      input_org_id, input_actor_id, 'drive_folder', input_parent_folder_id
    ) is distinct from 'owner')
    then raise insufficient_privilege using message = 'ownership-boundary move requires manager access'; end if;
  elsif coalesce(helix_drive_effective_role(
      input_org_id, input_actor_id, 'drive_folder', input_folder_id
    ), '') not in ('editor', 'owner') or (input_parent_folder_id is not null and coalesce(
      helix_drive_effective_role(input_org_id, input_actor_id, 'drive_folder', input_parent_folder_id), ''
    ) not in ('commenter', 'editor', 'owner'))
  then raise insufficient_privilege using message = 'Drive move requires source and destination access'; end if;

  update drive_folders set parent_folder_id = input_parent_folder_id,
    updated_at = statement_timestamp()
  where org_id = input_org_id and id = input_folder_id and deleted_at is null;
  if not found then raise no_data_found using message = 'Drive folder was not found'; end if;
  if source_drive is distinct from destination_drive then
    with recursive descendants as (
      select id from drive_folders where org_id = input_org_id and id = input_folder_id
      union all
      select child.id from drive_folders child join descendants parent on child.parent_folder_id = parent.id
      where child.org_id = input_org_id
    )
    update drive_folders set owner_actor_id = case
      when destination_drive is null then input_actor_id else null end,
      updated_at = statement_timestamp()
    where org_id = input_org_id and id in (select id from descendants);
    with recursive descendants as (
      select id from drive_folders where org_id = input_org_id and id = input_folder_id
      union all
      select child.id from drive_folders child join descendants parent on child.parent_folder_id = parent.id
      where child.org_id = input_org_id
    )
    update objects set owner_actor_id = case
      when destination_drive is null then input_actor_id else null end,
      updated_at = statement_timestamp()
    where org_id = input_org_id
      and nullif(metadata->>'folderId', '')::uuid in (select id from descendants);
  end if;
end
$$;

-- Comments, search indexing, and WebDAV now consume the same evaluator.
create or replace function drive_comment_actor_role_rank(input_org_id uuid, input_object_id uuid, input_actor_id uuid)
returns integer language sql stable security definer set search_path = pg_catalog, public set row_security = off as $$
  select case helix_drive_effective_role(input_org_id, input_actor_id, 'object', input_object_id)
    when 'owner' then 3 when 'editor' then 2 when 'commenter' then 1 when 'reader' then 0 else -1 end
$$;

create or replace function helix_drive_webdav_audience(
  p_org_id uuid, p_resource_type text, p_resource_id uuid, p_owner_actor_id uuid, p_folder_id uuid
)
returns uuid[] language sql stable security definer set search_path = pg_catalog, public set row_security = off as $$
  select helix_drive_visible_actor_ids(p_org_id, p_resource_type, p_resource_id)
$$;

-- Organization-owned files cannot be transferred to an individual.
create or replace function helix_drive_apply_ownership_transfer(p_org_id uuid, p_workflow_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
declare workflow drive_workflows%rowtype;
begin
  select * into strict workflow from drive_workflows
  where org_id = p_org_id and id = p_workflow_id and kind = 'ownership_transfer'
    and state = 'open' and assigned_to_actor_id = helix_current_actor_id() for update;
  if exists (
    with recursive ancestors as (
      select nullif(metadata->>'folderId', '')::uuid id from objects
      where org_id = p_org_id and id = workflow.resource_id
      union all select folder.parent_folder_id from drive_folders folder join ancestors on folder.id = ancestors.id
      where folder.org_id = p_org_id and folder.parent_folder_id is not null
    ) select 1 from drive_shared_drives drive join ancestors on ancestors.id = drive.root_folder_id
  ) then raise check_violation using message = 'organization-owned shared Drive files cannot transfer ownership'; end if;
  if not exists (
    select 1 from actors actor
    left join organization_memberships membership
      on membership.org_id = actor.org_id and membership.actor_id = actor.id
    where actor.org_id = p_org_id and actor.id = workflow.assigned_to_actor_id
      and actor.disabled_at is null
      and membership.status = 'active' and membership.guest_type = 'member'
  ) then raise insufficient_privilege using message = 'Drive ownership requires an active organization member'; end if;
  update objects set owner_actor_id = workflow.assigned_to_actor_id, updated_at = statement_timestamp()
  where org_id = p_org_id and id = workflow.resource_id
    and owner_actor_id = workflow.requested_by_actor_id;
  if not found then raise insufficient_privilege using message = 'Drive ownership changed before approval'; end if;
  update permissions set role = 'editor', updated_at = statement_timestamp()
  where org_id = p_org_id and resource_type = 'object' and resource_id = workflow.resource_id
    and actor_id = workflow.requested_by_actor_id;
  insert into permissions(org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
  values (p_org_id, workflow.requested_by_actor_id, 'object', workflow.resource_id, 'editor', helix_current_actor_id())
  on conflict do nothing;
end
$$;

alter table drive_shared_drives enable row level security;
alter table drive_shared_drives force row level security;
alter table drive_domain_grants enable row level security;
alter table drive_domain_grants force row level security;
alter table drive_acl_exceptions enable row level security;
alter table drive_acl_exceptions force row level security;
create policy helix_tenant_isolation on drive_shared_drives using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
create policy helix_tenant_isolation on drive_domain_grants using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());
create policy helix_tenant_isolation on drive_acl_exceptions using (org_id = helix_current_org_id()) with check (org_id = helix_current_org_id());

alter table drive_shared_drives owner to helix_migration_owner;
alter table drive_domain_grants owner to helix_migration_owner;
alter table drive_acl_exceptions owner to helix_migration_owner;
alter function helix_drive_shared_drive_id(uuid, uuid) owner to helix_migration_owner;
alter function helix_drive_normalize_object_owner() owner to helix_migration_owner;
alter function helix_drive_normalize_folder_owner() owner to helix_migration_owner;
alter function helix_drive_effective_role(uuid, uuid, text, uuid) owner to helix_migration_owner;
alter function helix_drive_visible_actor_ids(uuid, text, uuid) owner to helix_migration_owner;
alter function helix_set_drive_domain_grant(uuid, uuid, text, uuid, text, text, timestamptz) owner to helix_migration_owner;
alter function helix_revoke_drive_domain_grant(uuid, uuid, uuid) owner to helix_migration_owner;
alter function helix_set_drive_acl_exception(uuid, uuid, text, uuid, text, uuid, text, boolean) owner to helix_migration_owner;
alter function helix_drive_create_shared_drive(uuid, uuid, uuid, uuid, text) owner to helix_migration_owner;
alter function helix_drive_move_object(uuid, uuid, uuid, uuid) owner to helix_migration_owner;
alter function helix_drive_move_folder(uuid, uuid, uuid, uuid) owner to helix_migration_owner;
revoke all on drive_shared_drives, drive_domain_grants, drive_acl_exceptions from public;
grant select on drive_shared_drives, drive_domain_grants, drive_acl_exceptions to helix_app, helix_worker, helix_readonly;
revoke execute on function helix_drive_shared_drive_id(uuid, uuid) from public;
revoke execute on function helix_drive_normalize_object_owner() from public;
revoke execute on function helix_drive_normalize_folder_owner() from public;
revoke execute on function helix_drive_effective_role(uuid, uuid, text, uuid) from public;
revoke execute on function helix_drive_visible_actor_ids(uuid, text, uuid) from public;
revoke execute on function helix_set_drive_domain_grant(uuid, uuid, text, uuid, text, text, timestamptz) from public;
revoke execute on function helix_revoke_drive_domain_grant(uuid, uuid, uuid) from public;
revoke execute on function helix_set_drive_acl_exception(uuid, uuid, text, uuid, text, uuid, text, boolean) from public;
revoke execute on function helix_drive_create_shared_drive(uuid, uuid, uuid, uuid, text) from public;
revoke execute on function helix_drive_move_object(uuid, uuid, uuid, uuid) from public;
revoke execute on function helix_drive_move_folder(uuid, uuid, uuid, uuid) from public;
grant execute on function helix_drive_shared_drive_id(uuid, uuid) to helix_app, helix_worker;
grant execute on function helix_drive_effective_role(uuid, uuid, text, uuid) to helix_app, helix_worker;
grant execute on function helix_drive_visible_actor_ids(uuid, text, uuid) to helix_app, helix_worker;
grant execute on function helix_set_drive_domain_grant(uuid, uuid, text, uuid, text, text, timestamptz) to helix_app;
grant execute on function helix_revoke_drive_domain_grant(uuid, uuid, uuid) to helix_app;
grant execute on function helix_set_drive_acl_exception(uuid, uuid, text, uuid, text, uuid, text, boolean) to helix_app;
grant execute on function helix_drive_create_shared_drive(uuid, uuid, uuid, uuid, text) to helix_app;
grant execute on function helix_drive_move_object(uuid, uuid, uuid, uuid) to helix_app;
grant execute on function helix_drive_move_folder(uuid, uuid, uuid, uuid) to helix_app;
