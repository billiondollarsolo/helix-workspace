create table if not exists tenant_provisioning_state (
  org_id uuid primary key references orgs(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'waiting_for_verification', 'succeeded', 'failed')),
  requested_owner_email text not null,
  current_step text not null default 'signup_received',
  completed_steps text[] not null default '{}',
  attempt_count integer not null default 0,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists tenant_provisioning_state_status_idx
  on tenant_provisioning_state (status, updated_at);
