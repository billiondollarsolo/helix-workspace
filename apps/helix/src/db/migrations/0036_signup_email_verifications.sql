create table if not exists signup_email_verifications (
  org_id uuid primary key references orgs(id) on delete cascade,
  email text not null,
  password_hash text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists signup_email_verifications_token_hash_idx
  on signup_email_verifications (token_hash)
  where consumed_at is null;

create index if not exists signup_email_verifications_expires_at_idx
  on signup_email_verifications (expires_at)
  where consumed_at is null;
