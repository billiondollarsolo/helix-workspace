-- One shared state machine for Drive workflows. Resource data remains in the
-- canonical object/folder, classification, hold, and storage-policy models.
alter table admin_security_policies
  drop constraint admin_security_policies_policy_type_check,
  add constraint admin_security_policies_policy_type_check check (policy_type in (
    'mfa', 'sso', 'session', 'external_sharing', 'dlp', 'device_trust', 'drive_workflows'
  ));

create table drive_workflows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  kind text not null check (kind in (
    'shortcut', 'file_request', 'approval', 'ownership_transfer',
    'shared_drive', 'classification', 'hold', 'investigation'
  )),
  resource_type text not null check (resource_type in ('object', 'folder')),
  resource_id uuid not null,
  requested_by_actor_id uuid not null,
  assigned_to_actor_id uuid,
  state text not null default 'open'
    check (state in ('open', 'approved', 'rejected', 'cancelled', 'completed')),
  version bigint not null default 1 check (version > 0),
  payload jsonb not null default '{}',
  policy_snapshot jsonb not null default '{}',
  due_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  foreign key (org_id, requested_by_actor_id)
    references actors(org_id, id) on delete restrict,
  foreign key (org_id, assigned_to_actor_id)
    references actors(org_id, id) on delete restrict,
  check (due_at is null or due_at > created_at),
  check ((state = 'open' and decided_at is null) or (state <> 'open' and decided_at is not null)),
  check (kind not in ('file_request', 'approval', 'ownership_transfer', 'investigation')
    or assigned_to_actor_id is not null),
  check (kind <> 'ownership_transfer' or resource_type = 'object'),
  check (kind not in ('file_request', 'shared_drive') or resource_type = 'folder')
);

create index drive_workflows_actor_idx
  on drive_workflows (org_id, requested_by_actor_id, assigned_to_actor_id, updated_at desc);
create index drive_workflows_resource_idx
  on drive_workflows (org_id, resource_type, resource_id, updated_at desc);

create function helix_validate_drive_workflow()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
begin
  if new.resource_type = 'object' and not exists (
    select 1 from objects where org_id = new.org_id and id = new.resource_id
  ) then
    raise foreign_key_violation using message = 'Drive workflow object must belong to its tenant';
  elsif new.resource_type = 'folder' and not exists (
    select 1 from drive_folders where org_id = new.org_id and id = new.resource_id
  ) then
    raise foreign_key_violation using message = 'Drive workflow folder must belong to its tenant';
  end if;
  if tg_op = 'INSERT' then
    if (new.kind in ('shortcut', 'shared_drive', 'classification', 'hold')) <> (new.state = 'completed') then
      raise check_violation using message = 'Drive workflow initial state does not match its kind';
    end if;
  else
    if (new.org_id, new.id, new.kind, new.resource_type, new.resource_id,
        new.requested_by_actor_id, new.assigned_to_actor_id, new.policy_snapshot,
        new.due_at, new.created_at)
       is distinct from
       (old.org_id, old.id, old.kind, old.resource_type, old.resource_id,
        old.requested_by_actor_id, old.assigned_to_actor_id, old.policy_snapshot,
        old.due_at, old.created_at) then
      raise check_violation using message = 'Drive workflow identity and policy snapshot are immutable';
    end if;
    if old.state <> 'open' or new.state = 'open' then
      raise check_violation using message = 'Drive workflow transition must be final';
    end if;
    if (new.state = 'cancelled' and helix_current_actor_id() <> old.requested_by_actor_id)
       or (new.state <> 'cancelled' and helix_current_actor_id() <> old.assigned_to_actor_id) then
      raise insufficient_privilege using message = 'Drive workflow transition actor is invalid';
    end if;
    if new.state not in ('rejected', 'cancelled') and not (
      (old.kind in ('approval', 'ownership_transfer') and new.state = 'approved')
      or (old.kind in ('file_request', 'investigation') and new.state = 'completed')
    ) then
      raise check_violation using message = 'Drive workflow transition is invalid for its kind';
    end if;
    new.version := old.version + 1;
    new.updated_at := statement_timestamp();
  end if;
  return new;
end
$$;

create trigger drive_workflows_validate
before insert or update on drive_workflows
for each row execute function helix_validate_drive_workflow();

create function helix_drive_apply_ownership_transfer(p_org_id uuid, p_workflow_id uuid)
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
    and state = 'open' and assigned_to_actor_id = helix_current_actor_id()
  for update;
  update objects set owner_actor_id = workflow.assigned_to_actor_id,
    updated_at = statement_timestamp()
  where org_id = p_org_id and id = workflow.resource_id
    and owner_actor_id = workflow.requested_by_actor_id;
  if not found then raise insufficient_privilege using message = 'Drive ownership changed before approval'; end if;

  with desired(actor_id, role) as (values
    (workflow.assigned_to_actor_id, 'owner'::text),
    (workflow.requested_by_actor_id, 'editor'::text)
  ), updated as (
    update permissions permission set
      role = desired.role, granted_by_actor_id = helix_current_actor_id(), status = 'active',
      valid_from = statement_timestamp(), revoked_at = null, revocation_epoch = 0,
      updated_at = statement_timestamp()
    from desired where permission.org_id = p_org_id
      and permission.actor_id = desired.actor_id and permission.resource_type = 'object'
      and permission.resource_id = workflow.resource_id
    returning permission.actor_id
  )
  insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
  select p_org_id, desired.actor_id, 'object', workflow.resource_id, desired.role,
    helix_current_actor_id()
  from desired where not exists (select 1 from updated where updated.actor_id = desired.actor_id);
end
$$;

alter table drive_workflows enable row level security;
alter table drive_workflows force row level security;
create policy drive_workflows_read on drive_workflows for select using (
  org_id = helix_current_org_id()
  and helix_current_actor_id() in (requested_by_actor_id, assigned_to_actor_id)
);
create policy drive_workflows_create on drive_workflows for insert with check (
  org_id = helix_current_org_id() and requested_by_actor_id = helix_current_actor_id()
);
create policy drive_workflows_update on drive_workflows for update using (
  org_id = helix_current_org_id()
  and helix_current_actor_id() in (requested_by_actor_id, assigned_to_actor_id)
) with check (org_id = helix_current_org_id());

alter table drive_workflows owner to helix_migration_owner;
alter function helix_validate_drive_workflow() owner to helix_migration_owner;
alter function helix_drive_apply_ownership_transfer(uuid, uuid) owner to helix_migration_owner;
revoke all on drive_workflows from public;
revoke all on function helix_validate_drive_workflow() from public;
revoke all on function helix_drive_apply_ownership_transfer(uuid, uuid) from public;
grant select, insert, update on drive_workflows to helix_app;
grant execute on function helix_drive_apply_ownership_transfer(uuid, uuid) to helix_app;
grant select on drive_workflows to helix_readonly;
