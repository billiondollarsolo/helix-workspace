create table bot_account_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  requester_actor_id uuid not null,
  external_bot_id text not null check(length(external_bot_id) between 1 and 200),
  display_name text not null check(length(display_name) between 1 and 120),
  purpose text not null check(length(purpose) between 1 and 1000),
  requested_email text,
  requested_scopes text[] not null,
  api_key_hash text not null check(api_key_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check(status in ('pending','approved','rejected','expired')),
  bot_actor_id uuid,
  credential_id uuid,
  owner_actor_id uuid,
  approved_scopes text[] not null default '{}',
  approved_email text,
  reason text,
  decided_by_actor_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '7 days',
  decided_at timestamptz,
  unique(org_id,requester_actor_id,external_bot_id),
  foreign key(org_id,requester_actor_id) references actors(org_id,id) on delete cascade,
  foreign key(org_id,bot_actor_id) references actors(org_id,id) on delete cascade,
  foreign key(org_id,owner_actor_id) references actors(org_id,id)
);
create table bot_account_observers (
  org_id uuid not null,
  bot_actor_id uuid not null,
  observer_actor_id uuid not null,
  granted_by_actor_id uuid not null,
  created_at timestamptz not null default now(),
  primary key(org_id,bot_actor_id,observer_actor_id),
  foreign key(org_id,bot_actor_id) references actors(org_id,id) on delete cascade,
  foreign key(org_id,observer_actor_id) references actors(org_id,id) on delete cascade
);
alter table bot_account_requests enable row level security;
alter table bot_account_requests force row level security;
alter table bot_account_observers enable row level security;
alter table bot_account_observers force row level security;
create policy helix_tenant_isolation on bot_account_requests
  using(org_id=helix_current_org_id()) with check(org_id=helix_current_org_id());
create policy helix_tenant_isolation on bot_account_observers
  using(org_id=helix_current_org_id()) with check(org_id=helix_current_org_id());
revoke all on bot_account_requests,bot_account_observers from public,helix_readonly;
grant select,insert,update,delete on bot_account_requests,bot_account_observers to helix_app,helix_worker;
