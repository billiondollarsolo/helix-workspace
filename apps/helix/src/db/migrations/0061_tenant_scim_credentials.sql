-- Per-tenant SCIM bearer-token credentials. Stores only the hash of the token
-- (argon2id) so a database leak does not expose live SCIM secrets. One active
-- token per tenant for now; rotation is handled by replacing the row.
create table if not exists tenant_scim_credentials (
  org_id uuid primary key references orgs(id) on delete cascade,
  token_hash text not null,
  token_hint text,
  rotated_at timestamptz not null default now(),
  rotated_by_actor_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_scim_credentials_token_hash_nonempty check (length(token_hash) > 0)
);

create index if not exists tenant_scim_credentials_rotated_idx
  on tenant_scim_credentials (rotated_at desc);
