create table federation_applications (
  org_id uuid not null references orgs(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  public_origin text not null,
  installation_id text not null,
  tenant_id text not null,
  status text not null default 'prepared' check(status in ('prepared','awaiting-peer','active','expired','failed','revoked')),
  created_by_actor_id uuid not null,
  pairing_digest text not null unique,
  proof_digest text not null,
  pairing_expires_at timestamptz not null,
  oidc_client_id text unique references "oauthClient"("clientId") on delete set null,
  receipt_envelope text,
  revision bigint not null default 0,
  acknowledged_revision bigint not null default 0,
  desired_hash text,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(org_id,id),
  foreign key(org_id,created_by_actor_id) references actors(org_id,id)
);
create unique index federation_application_installation on federation_applications(org_id,installation_id,tenant_id) where status not in ('revoked','expired','failed');
create table federation_app_assignments (
  org_id uuid not null,
  application_id uuid not null,
  actor_id uuid not null,
  role text not null check(role in ('viewer','member','admin')),
  primary key(org_id,application_id,actor_id),
  foreign key(org_id,application_id) references federation_applications(org_id,id) on delete cascade,
  foreign key(org_id,actor_id) references actors(org_id,id) on delete cascade
);
alter table federation_applications enable row level security;
alter table federation_applications force row level security;
create policy helix_tenant_isolation on federation_applications using(org_id=helix_current_org_id()) with check(org_id=helix_current_org_id());
alter table federation_app_assignments enable row level security;
alter table federation_app_assignments force row level security;
create policy helix_tenant_isolation on federation_app_assignments using(org_id=helix_current_org_id()) with check(org_id=helix_current_org_id());
revoke all on federation_applications,federation_app_assignments from public,helix_readonly;
grant select,insert,update,delete on federation_applications,federation_app_assignments to helix_app;
