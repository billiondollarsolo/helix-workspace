create table federation_backup_targets (
  org_id uuid not null references orgs(id),
  id uuid not null,
  application_id uuid,
  public_origin text not null,
  binding jsonb not null,
  credential_envelope text,
  policy jsonb not null,
  policy_pending boolean not null default false,
  status text not null default 'active' check(status in ('active','detach_pending','detached')),
  observed_status jsonb,
  observed_at timestamptz,
  last_error text,
  created_by_actor_id uuid not null,
  updated_at timestamptz not null default now(),
  primary key(org_id,id),
  unique nulls not distinct(org_id,application_id),
  foreign key(org_id,application_id) references federation_applications(org_id,id),
  foreign key(org_id,created_by_actor_id) references actors(org_id,id)
);
create table federation_backup_jobs (
  org_id uuid not null,
  id uuid not null,
  target_id uuid not null,
  requested_by_actor_id uuid not null,
  approved_by_actor_id uuid,
  required_approvals integer not null check(required_approvals in (0,1)),
  request jsonb not null,
  status text not null check(status in ('pending_approval','queued','running','completed','failed','unknown')),
  result jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(org_id,id),
  foreign key(org_id,target_id) references federation_backup_targets(org_id,id),
  foreign key(org_id,requested_by_actor_id) references actors(org_id,id),
  foreign key(org_id,approved_by_actor_id) references actors(org_id,id),
  check(approved_by_actor_id is null or approved_by_actor_id<>requested_by_actor_id)
);
create table federation_recovery_sets (
  org_id uuid not null references orgs(id),
  id uuid not null,
  manifest jsonb not null,
  digest text not null,
  created_by_actor_id uuid not null,
  created_at timestamptz not null default now(),
  primary key(org_id,id),
  foreign key(org_id,created_by_actor_id) references actors(org_id,id)
);
do $$ declare name text; begin
  foreach name in array array['federation_backup_targets','federation_backup_jobs','federation_recovery_sets'] loop
    execute format('alter table %I enable row level security',name);
    execute format('alter table %I force row level security',name);
    execute format('create policy helix_tenant_isolation on %I using (org_id=helix_current_org_id()) with check (org_id=helix_current_org_id())',name);
    execute format('create policy helix_tenant_boundary on %I as restrictive using (org_id=helix_current_org_id()) with check (org_id=helix_current_org_id())',name);
    execute format('revoke all on %I from public,helix_readonly',name);
    execute format('grant select,insert,update,delete on %I to helix_app',name);
  end loop;
end $$;
