create table if not exists signup_onboarding_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  invited_by_actor_id uuid not null references actors(id),
  email text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by_actor_id uuid references actors(id),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists signup_onboarding_invites_org_email_idx
  on signup_onboarding_invites (org_id, lower(email))
  where accepted_at is null;

create index if not exists signup_onboarding_invites_token_hash_idx
  on signup_onboarding_invites (token_hash)
  where accepted_at is null;

create index if not exists signup_onboarding_invites_expires_at_idx
  on signup_onboarding_invites (expires_at)
  where accepted_at is null;
