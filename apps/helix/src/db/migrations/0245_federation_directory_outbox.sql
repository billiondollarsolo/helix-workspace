alter table federation_applications
  add column connection_id uuid,
  add column directory_revision bigint not null default 0,
  add column directory_pending boolean not null default true,
  add column desired_snapshot jsonb,
  add column next_sync_at timestamptz not null default now(),
  add column retry_count integer not null default 0;

-- Directory writes and their invalidation are committed together. Delivery
-- reconciles current desired state rather than replaying old membership events.
create function helix_federation_directory_changed() returns trigger language plpgsql
set search_path=pg_catalog,public as $$
declare tenant uuid;
begin
  if tg_op='DELETE' then tenant:=old.org_id; else tenant:=new.org_id; end if;
  update federation_applications set directory_revision=directory_revision+1,
    directory_pending=true,next_sync_at=now(),updated_at=now()
    where org_id=tenant and status in ('active','awaiting-peer');
  return null;
end $$;
create trigger federation_assignment_changed after insert or update or delete on federation_app_assignments for each row execute function helix_federation_directory_changed();
create trigger federation_membership_changed after insert or update or delete on organization_memberships for each row execute function helix_federation_directory_changed();
create trigger federation_actor_changed after update of email,display_name,disabled_at,scopes on actors for each row execute function helix_federation_directory_changed();
create trigger federation_group_changed after insert or update or delete on admin_group_members for each row execute function helix_federation_directory_changed();
